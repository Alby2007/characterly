import type { Brain } from "./brain.js";
import type { MemoryStore } from "./database.js";
import { defaultEmbedder, vectorLiteral } from "./embeddings.js";
import { FatalJobError } from "./jobs.js";
import { inc } from "./metrics.js";
import { logError } from "./secrets.js";

// ── Journal job handler ──────────────────────────────────────────────────────
// After a companion speaks, this deferrable job writes its first-person
// journal: 0–2 entries about what *it* experienced, origin-tagged to the job's
// scope. Consent rule is identical to extract-job — entries about
// non-consenting humans are dropped, so an opted-out member never becomes
// journal content. Lives outside index.ts for unit-testability.

export type JournalJobPayload = {
  companionId: number;
  /** The human message the companion replied to. */
  triggerMessageId: string;
  /** The companion's own archived reply row. */
  replyMessageId: string;
  channelId: string;
};

export interface JournalJobDeps {
  store: MemoryStore;
  brainFor: (guildId: string) => Promise<Brain | null>;
  botId: string;
}

export async function runJournalJob(scope: string, payload: JournalJobPayload, deps: JournalJobDeps): Promise<void> {
  if (!payload?.companionId || !payload.triggerMessageId || !payload.replyMessageId) {
    throw new FatalJobError("malformed journal-write payload");
  }
  const { store } = deps;
  // Re-read the archive rows: a deleted trigger or reply means the exchange is
  // gone — journaling it would resurrect content the author removed.
  const [trigger, reply] = await Promise.all([
    store.getMessage(scope, payload.triggerMessageId),
    store.getMessage(scope, payload.replyMessageId),
  ]);
  if (!trigger || !reply) { inc("jobs.dropped_stale"); return; }

  const companion = await store.getCompanionById(payload.companionId);
  if (!companion || companion.onboardingState !== "active") { inc("jobs.dropped_stale"); return; }

  const brain = await deps.brainFor(scope);
  if (!brain) { inc("jobs.dropped_dormant"); return; }

  // Last few channel rows give the writer the beat the reply landed in —
  // bounded so the prompt stays small on a busy channel.
  const recent = await store.recentContext(scope, payload.channelId, 8);
  const context = recent
    .filter(r => r.content?.trim())
    .map(r => `${r.authorName} (${r.authorId}): ${r.content}`)
    .join("\n");

  const entries = await brain.writeJournal({
    name: companion.name,
    voicePersona: companion.voicePersona,
    coreTraits: companion.coreTraits,
    context,
    reply: reply.content,
  });
  if (!entries.length) return;

  // Same consent gate as extraction: derived data about a person persists
  // only for opted-in members; companions and the bot count as consented.
  const consentCache = new Map<string, boolean>();
  const isConsented = async (subjectId: string) => {
    if (subjectId === "unknown" || subjectId === "server" || subjectId === deps.botId || subjectId.startsWith("companion:")) return true;
    const cached = consentCache.get(subjectId);
    if (cached !== undefined) return cached;
    const m = await store.getMember(scope, subjectId);
    const ok = !!m?.optedIn && !m.optedOut;
    consentCache.set(subjectId, ok);
    return ok;
  };

  try {
    const saved = await store.saveJournalEntries(
      payload.companionId, scope, entries, payload.replyMessageId, isConsented,
    );
    if (saved.length) {
      inc("journal.saved", saved.length);
      // Embed inline — the backfill sweep repairs any failure. Non-fatal:
      // a dead embed endpoint must never sink journal writes.
      for (const e of saved) {
        void defaultEmbedder().embed(e.content)
          .then(v => (v ? store.setJournalEmbedding(e.id, vectorLiteral(v)) : undefined))
          .catch(err => { inc("embed.error"); logError("journal embed failed", err); });
      }
    }
  } catch (error) {
    inc("journal.save_error");
    logError("Journal save failed", error);
  }
}
