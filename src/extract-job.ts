import type { Brain, LlmClient } from "./brain.js";
import type { MemoryStore } from "./database.js";
import type { EventStore } from "./events.js";
import type { EventPipeline } from "./event-detection.js";
import type { AliasMap } from "./entity-resolution.js";
import type { MessageEvent } from "./types.js";
import { BudgetExceeded, meteredClient } from "./budget.js";
import { detectNamingRequest, detectSelfNaming } from "./perception.js";
import { formatImageContext } from "./vision.js";
import { persistExtraction } from "./persist-extraction.js";
import { runContestCheck } from "./contest.js";
import { withRetry } from "./retry.js";
import { inc } from "./metrics.js";
import { logError } from "./secrets.js";
import { isUserScope } from "./scopes.js";

// ── Extract job handler ──────────────────────────────────────────────────────
// Everything deferrable about a durable message runs here, off the live path:
// alias-learn → describe → extract → persist → terminal triage mark → contest
// → event pipeline. Per-guild serial (maxPerGuild=1 in the worker) preserves
// pipeline/event ordering. A retry of a job whose message is already marked
// 'extracted' resumes at the tail stages — persistence is idempotent but the
// LLM calls behind it are not free, so the rerun recovers saved memory ids
// from evidence rather than re-extracting. BudgetExceeded from ANY stage
// propagates so the worker reschedules the job to the UTC-day reset without
// burning an attempt;
// other failures retry with backoff (capped at 5 attempts, then dead-letter —
// the sweep's repairQueuedMarks pass turns the stranded 'queued' mark 'dead',
// terminal but visible, and requeueable via scripts/requeue-dead-jobs.mjs).
// Lives outside index.ts so it can be unit-tested (index.ts logs in on import).

export type ExtractJobPayload = {
  event: Omit<MessageEvent, "createdAt"> & { createdAt: string };
  replyToId?: string;
  replyToContent?: string;
  /** Companion the turn belongs to — story_fact rows are scoped to it. Absent
   *  for ambient server messages with no addressee; those land unscoped. */
  companionId?: number;
  /** True when the turn's companion is roleplay-flagged (adopted personas) —
   *  biases the extractor toward in_fiction unless plainly real-world. */
  fictionHint?: boolean;
};

export interface ExtractJobDeps {
  store: MemoryStore;
  brainFor: (guildId: string) => Promise<Brain | null>;
  eventStore: EventStore;
  pipeline: EventPipeline;
  botId: string;
  visionModel?: string;
  visionClient?: LlmClient;
  contestModel?: string;
  imageMaxBytes: number;
  /** DM scopes have no server_settings cap of their own — vision calls made
   * inside a dm:<id> job meter against this instead of the auto-created
   * default, matching the live DM path's DM_LLM_DAILY_CAP. */
  dmLlmDailyCap?: number;
  /** The fleet-wide hosted breaker (scope 'hosted:global') — a separate
   * vision client is operator spend regardless of who's BYOK, so vision calls
   * count against it. */
  hostedDailyCap?: number;
  /** Alias/name lookups — index.ts serves these from its TTL cache; tests can
   * return a static map. */
  getAliases: (guildId: string) => Promise<AliasMap>;
  /** Drop the guild's cached lookups when learnAlias teaches a new name. */
  invalidateLookups: (guildId: string) => void;
}

export async function runExtractJob(payload: ExtractJobPayload, deps: ExtractJobDeps): Promise<void> {
  const event: MessageEvent = { ...payload.event, createdAt: new Date(payload.event.createdAt) };
  const guildId = event.guildId;
  // The payload is an enqueue-time snapshot — re-read the archive row so a
  // deleted message is dropped (a queued job must not resurrect content the
  // author deleted, or write fresh evidence for it) and an edit's current
  // text is what gets extracted. Bot-authored rows are archive-only context,
  // never a memory source.
  const stored = await deps.store.getMessage(guildId, event.messageId);
  if (!stored || stored.authorIsBot) { inc("jobs.dropped_stale"); return; }
  event.content = stored.content;
  const brain = await deps.brainFor(guildId);
  if (!brain) { inc("jobs.dropped_dormant"); return; } // went dormant — drop, no retry
  const { store, botId } = deps;
  const images = event.imageAttachments ?? [];

  // 'extracted' is written before contest/pipeline, so a job retried after a
  // mid-tail failure (BudgetExceeded, transient error) lands here with
  // persistence already applied. Re-running extraction would re-bill the LLM
  // for identical work — recover the saved ids from evidence and resume at
  // the tail stages instead.
  let savedIds: number[];
  if (stored.triageResult === "extracted") {
    inc("jobs.resumed_tail");
    savedIds = await store.memoryIdsForMessage(event.messageId);
  } else {
    // The reply target can have been deleted or edited since enqueue too —
    // refresh it from the archive; gone means no context, not stale context.
    let replyToContent = payload.replyToContent;
    if (payload.replyToId) {
      const ref = await deps.store.getMessage(guildId, payload.replyToId);
      replyToContent = ref ? `${ref.authorName}: ${ref.content}` : undefined;
    }

    // Naming signals — same order as the old inline path (request, then weak
    // self-name). learnAlias is cheap; the LLM spend starts below.
    const member = await store.getMember(guildId, event.authorId);
    const authorNames = member?.knownNames ?? [event.authorName];
    const requested = detectNamingRequest(event.content, authorNames);
    const named = requested ?? detectSelfNaming(event.content, authorNames);
    if (named) {
      await store.learnAlias(guildId, event.authorId, named, requested ? "naming_request" : "self_naming", event.messageId);
      deps.invalidateLookups(guildId);
    }
    const note = requested
      ? `the author asked to be called "${requested}" — treat it as their preferred name`
      : named ? `the author may be naming themselves "${named}" (a previously unknown alias) or quoting/describing "${named}" — attribute accordingly` : undefined;

    // A separate vision client (VISION_API_KEY/BASE_URL ≠ main creds) is the
    // operator's spend, not the guild's key — but it still counts against the
    // guild's daily cap, so it's wrapped in the same meter. When visionClient is
    // undefined, describeImage falls back to the brain's already-metered client.
    // The result caches on the archive row (image_context) — the reply path
    // reuses it instead of paying for a second describe.
    let imageContext: string | undefined = stored.imageContext ?? undefined;
    if (!imageContext && images.length && deps.visionModel) {
      const scopeMetered = deps.visionClient
        ? meteredClient(deps.visionClient, { guildId, store: deps.store, getCap: async () =>
            isUserScope(guildId) && deps.dmLlmDailyCap !== undefined
              ? deps.dmLlmDailyCap
              : (await deps.store.settings(guildId)).llmDailyCap })
        : undefined;
      const vision = scopeMetered && deps.hostedDailyCap !== undefined
        ? meteredClient(scopeMetered, { guildId: "hosted:global", store: deps.store, getCap: async () => deps.hostedDailyCap! })
        : scopeMetered;
      const descs = await Promise.all(images.map(async a => {
        try {
          const d = await brain.describeImage({ url: a.url, contextText: event.content, maxBytes: deps.imageMaxBytes }, deps.visionModel!, vision);
          inc("vision.described");
          return d.description;
        } catch (error) {
          if (error instanceof BudgetExceeded) throw error; // reschedule — the image must not be extracted silently stripped of its context
          inc("vision.error"); logError("Image describe failed", error); return undefined;
        }
      })).then(list => list.filter((d): d is string => !!d));
      imageContext = formatImageContext(descs, event.authorName) || undefined;
      if (imageContext) await store.setImageContext(guildId, event.messageId, imageContext).catch(() => inc("recall.image_context_error"));
    }

    // Established nature labels — the model reuses "close friends" instead of
    // fragmenting the vocabulary into synonym churn. One cheap indexed query.
    const natureVocab = await store.relationshipNatureVocab(guildId);
    const { memories: candidates, relationships } = await withRetry(() => brain.extractMemories(event, replyToContent, note, imageContext, natureVocab, payload.fictionHint), 3);
    const aliases = (candidates.length || relationships.length) ? await deps.getAliases(guildId) : new Map<string, string>();
    // Opt-in consent — identical rule to the sweep/ingest paths: derived person
    // data persists only for consenting members; the bot and summoned/active
    // companions (subject_id 'companion:<id>') count as consented.
    const consentCache = new Map<string, boolean>();
    const isConsented = async (userId: string) => {
      if (userId === "unknown" || userId === "server" || userId === botId || userId.startsWith("companion:")) return true;
      const cached = consentCache.get(userId);
      if (cached !== undefined) return cached;
      const m = await store.getMember(guildId, userId);
      const ok = !!m?.optedIn && !m.optedOut;
      consentCache.set(userId, ok);
      return ok;
    };
    const persisted = await persistExtraction(
      { memories: candidates, relationships },
      event,
      { store, aliases, isConsented, companionId: payload.companionId, onMemorySaved: () => inc("memory.saved") },
    );
    savedIds = persisted.savedIds;
    // Terminal mark — extraction ran even if it yielded nothing.
    await store.setTriageResults([{ id: event.messageId, result: "extracted" }]);
  }
  try {
    await runContestCheck(event, brain, store, botId, deps.contestModel);
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error; // reschedule — cap is not a fault
    inc("contest.error"); logError("Contest check failed", error);
  }
  try {
    await deps.pipeline.process(event, savedIds, deps.eventStore, store, brain, payload.replyToId);
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    inc("pipeline.error"); logError("Event pipeline failed", error);
  }
}
