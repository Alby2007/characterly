import type { MessageReplyOptions } from "discord.js";
import type OpenAI from "openai";
import type { Sql } from "./db.js";
import { MemoryStore, type Memory } from "./database.js";
import type { Brain } from "./brain.js";
import { looksLikeSchemaLeak, shouldInspectForMemory, toolCues } from "./perception.js";
import type { ReplyThrottle } from "./reply-throttle.js";
import type { EventStore } from "./events.js";
import type { ProfileStore } from "./profiles.js";
import type { AliasMap } from "./entity-resolution.js";
import { demangleMentions, scrubMentions } from "./entity-resolution.js";
import { enqueue } from "./jobs.js";
import { buildPairContext, type ToolCtx } from "./lookup-tools.js";
import { formatImageContext, type AttachmentMeta } from "./vision.js";
import { inc } from "./metrics.js";
import { logError } from "./secrets.js";
import { BudgetExceeded, meteredClient } from "./budget.js";
import { isSelfHarmSignal, CRISIS_RESPONSE } from "./safety.js";
import { TurnLedger, chargeHostedTurn, screenAdoptedReply } from "./turn-billing.js";
import { gatherServerDigestForDm } from "./cross-context.js";
import { matchLore } from "./lorebook.js";
import type { Companion, CompanionPersona, JournalEntry, MessageEvent } from "./types.js";

// ── One companion turn ─────────────────────────────────────────────────────
// Archive → extraction → crisis → throttle → billing → context → generate →
// screen → send → journal. Transport-free: the caller supplies sendPersona
// (post the reply, return its id) and sendSystem (post a notice). The DM lane,
// #adoptees threads, and web chat all run this — only the sends differ.

export type CompanionTurnOpts = {
  scope: string;
  userId: string;
  channel: { id: string; sendTyping?(): Promise<unknown>; send?(o: unknown): Promise<unknown> };
  companion: Companion;
  event: MessageEvent;
  replyToId?: string;
  images: Array<AttachmentMeta & { contentType: string }>;
  account: { plan?: string | null } | null;
  sendPersona: (text: string) => Promise<{ id: string; createdAt: Date } | null>;
  sendSystem: (payload: MessageReplyOptions) => Promise<unknown>;
  /** Regenerate mode (right-click retry): the trigger is already archived and
   *  extracted, and sendPersona edits the existing reply in place — so
   *  re-archive, extraction, the reply throttle, journal and summary all skip,
   *  and the outgoing take is filtered out of context so the model doesn't
   *  anchor on its last answer. */
  regen?: { targetMessageId: string; targetContent: string };
  /** Charge override — regen bills the reply half only (the trigger already
   *  paid when it arrived). payerAccountId keys the spend on web_profiles.id
   *  directly (web chat, where payerId may not be a Discord id at all). */
  charge?: { cost: number; reason: string; refundReason: string; payerAccountId?: string };
};

/** Every live singleton the turn needs — index.ts binds the real ones, tests
 *  inject fakes. Keeping the seams named (not positional) means a web-turn
 *  test can stub just the edges it asserts on. */
export type CompanionTurnDeps = {
  store: MemoryStore;
  sql: Sql;
  config: Pick<typeof import("./config.js").config,
    "rawMessageRetentionDays" | "dmContextMessages" | "visionModel" | "imageMaxBytes"
    | "replyModel" | "replyTools" | "dmLlmDailyCap" | "keyEncryptionSecret" | "siteUrl">;
  brainFor: (scope: string) => Promise<Brain | null>;
  isHostedScope: (scope: string) => boolean;
  replyThrottle: ReplyThrottle;
  fleetCap: { getEffective(): Promise<number> };
  visionClient: OpenAI | undefined;
  hostedSafety: () => Pick<Brain, "safetyVerdict"> | null;
  profileStore: ProfileStore;
  eventStore: EventStore;
  embed: (text: string) => Promise<number[] | null>;
  guildLookups: (scope: string) => Promise<{ map: AliasMap; names: Map<string, string> }>;
  resolveGuildName: (guildId: string) => string | undefined;
  maybeAlertLowCredit: (userId: string, balance: number) => Promise<void>;
  maybeEnqueueSummary: (companionId: number, scope: string, channelId: string) => Promise<void>;
  promptMemories: (scope: string, subjectId: string, text: string, vec: number[] | null, companionId?: number | null) => Promise<Memory[]>;
  promptJournal: (companionId: number, scope: string, aboutIds: string[], vec: number[] | null) => Promise<JournalEntry[]>;
  apiKeyPayload: (userId: string) => unknown;
  chargeRefusalNotice: (reason: "pressure" | "insufficient" | "unlinked") => string;
  dailyResetTag: () => string;
  hostedCapacity: () => string;
  budgetNoticeOnce: (channelId: string) => boolean;
  toolsNudgeDue: (userId: string) => boolean;
  nextHourBoundary: () => Date;
  startTyping: (channel: { sendTyping?(): Promise<unknown> }) => () => void;
};

/** One companion turn — archive, extraction, crisis, billing, generation,
 *  persona send, journal. Returns nothing — notices ride sendSystem,
 *  failures ride metrics. */
export async function runCompanionTurn(deps: CompanionTurnDeps, opts: CompanionTurnOpts): Promise<void> {
  const { store, sql, config } = deps;
  const { scope, userId, channel, companion, event, replyToId, images, account, sendPersona, sendSystem, regen } = opts;
  const compSubj = MemoryStore.companionSubjectId(companion.id);
  const settings = await store.settings(scope, config.rawMessageRetentionDays);
  if (!settings.memoryEnabled && !settings.replyEnabled) return;
  if (settings.memoryEnabled && !regen) {
    await store.recordMessage(event, replyToId, true, false);
  }

  let replyToContent: string | undefined;
  if (replyToId) {
    const ref = await store.getMessage(scope, replyToId);
    if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
  }

  if (!regen && settings.memoryEnabled && (shouldInspectForMemory(event) || images.length)) {
    try {
      // Free+hosted memory settles in hourly batches; premium/BYOK is live.
      const throttleMemory = account?.plan === "free" && deps.isHostedScope(scope);
      await enqueue(sql, scope, "extract", { event, replyToId, replyToContent, companionId: companion.id, fictionHint: companion.kind === "adopted" }, throttleMemory ? deps.nextHourBoundary() : undefined);
      await store.setTriageResults([{ id: event.messageId, result: "queued" }]);
      inc("jobs.enqueued");
    } catch (error) { inc("jobs.enqueue_error"); logError("DM extraction enqueue failed", error); }
  }

  if (!settings.replyEnabled) return;

  // Self-harm triage fires before any spend or throttle — the message is
  // already recorded (extraction can still remember the disclosure), but the
  // reply is a scripted crisis response, not a generation. No judgment call.
  if (isSelfHarmSignal(event.content)) {
    inc("safety.crisis");
    await sendSystem({ content: CRISIS_RESPONSE });
    return;
  }

  // Regen skips the burst throttle — it replaces a reply rather than adding
  // one, and its own cooldown + daily cap + charge bound it instead.
  if (!regen && !deps.replyThrottle.consume(scope, userId)) { inc("reply.cooldown"); return; }

  const brain = await deps.brainFor(scope);
  if (!brain) {
    if (!regen) deps.replyThrottle.refund(scope, userId);
    if (config.keyEncryptionSecret) {
      await sendSystem(deps.apiKeyPayload(userId) as MessageReplyOptions);
    }
    return;
  }

  // Hosted lane bills the turn upfront: the human pays for their message +
  // the companion's reply (2 tokens); a reply that never lands refunds them.
  const hostedDm = deps.isHostedScope(scope);
  let ledger = TurnLedger.free(userId);
  if (hostedDm) {
    const charge = await chargeHostedTurn(store, {
      payerId: userId, payerAccountId: opts.charge?.payerAccountId,
      cost: opts.charge?.cost ?? 2, reason: opts.charge?.reason ?? "dm_turn",
      refundReason: opts.charge?.refundReason ?? "dm_turn_refund",
      premium: account?.plan === "premium", hostedDailyLlmCap: await deps.fleetCap.getEffective(),
    });
    if (!charge.ok) {
      if (!regen) deps.replyThrottle.refund(scope, userId);
      // The once-per-channel gate exists to keep refusal notices from
      // spamming a channel; regen's sendSystem lands on a private ephemeral
      // instead, so the refusal always reaches the requester.
      if (regen || deps.budgetNoticeOnce(channel.id)) await sendSystem({ content: deps.chargeRefusalNotice(charge.reason) });
      return;
    }
    ledger = charge.ledger;
  }

  const stopTyping = deps.startTyping(channel);
  try {
    // Every context read below is independent — fetch them concurrently so
    // the reply waits on one round of DB latency, not ~15 sequential ones.
    // The embed call gates only the two semantic recall legs.
    const recallText = `${event.content} ${replyToContent ?? ""}`;
    const vecP = deps.embed(recallText).catch(() => null);
    const [
      lookups, profileBundle, pair, rawContext, freshOwnerName, serverDigest,
      journal, storyRow, dmMemories, dmSelfMems, cachedImageContext, loreListing,
    ] = await Promise.all([
      deps.guildLookups(scope),
      deps.profileStore.getProfiles(scope, [userId, compSubj]).then(async rows => ({
        rows, attrMap: await store.attributesForSubjects(scope, rows.map(p => p.subjectId), { status: "active" }),
      })),
      buildPairContext(store, deps.eventStore, scope, userId, compSubj),
      // DM window is wider than the guild default (config.dmContextMessages,
      // 40) — a 1:1 chat has no other voices competing for the transcript, and
      // anything older than STORY_KEEP_RECENT is folded into the recap anyway.
      store.recentContext(scope, channel.id, config.dmContextMessages),
      store.displayNameFor(scope, userId),
      gatherServerDigestForDm(store, deps.eventStore, userId, companion, deps.resolveGuildName),
      vecP.then(v => deps.promptJournal(companion.id, scope, [userId], v)),
      store.getStorySummary(companion.id, scope, channel.id).catch(() => null),
      // The companion's own memories (subject companion:<id>) — things it
      // learned about itself, e.g. corrections to its persona — merge with the
      // speaker's below.
      vecP.then(v => deps.promptMemories(scope, userId, recallText, v, companion.id)),
      store.relevantMemories(scope, compSubj, 3, companion.id).catch(() => [] as Memory[]),
      (images.length || regen) && config.visionModel
        ? store.getMessage(scope, event.messageId).then(m => m?.imageContext ?? undefined)
        : Promise.resolve(undefined),
      // The adopted listing — its lorebook is per-turn world canon (v69).
      // Awakened companions have no listing → no fetch, no canon.
      companion.adoptedFromListingId
        ? store.listingById(companion.adoptedFromListingId).catch(() => null)
        : Promise.resolve(null),
    ]);
    const profiles = profileBundle.rows.map(p => ({
      name: p.displayName,
      summary: p.summary,
      traits: p.facets.traits,
      attributes: (profileBundle.attrMap.get(p.subjectId) ?? []).map(a => ({ field: a.field, value: a.value, confidence: a.confidence })),
    }));
    const relationships = pair ? [pair] : [];
    const context = (regen
      // The outgoing take stays out of context — reading its own last answer
      // anchors the model into echoing it instead of producing a new take.
      ? rawContext.filter(x => !(x.authorId === compSubj && x.content === regen.targetContent))
      : rawContext
    ).map(x => ({
      ...x,
      content: demangleMentions(x.content, lookups.names),
      replyToSnippet: x.replyToSnippet ? demangleMentions(x.replyToSnippet, lookups.names) : undefined,
    }));
    const persona: CompanionPersona = {
      companionId: companion.id,
      name: companion.name,
      ownerUserId: companion.ownerUserId,
      ownerName: freshOwnerName,
      voicePersona: companion.voicePersona,
      coreTraits: companion.coreTraits,
      ownerDynamic: companion.ownerDynamic,
      backstory: companion.backstory,
      serverDigest,
      journal,
      storySummary: storyRow?.summary || undefined,
    };
    // Authored world canon — entries fire on key hits against the recent
    // transcript tail + this turn. Listing edits are live for every adopter
    // (resolved per turn, not copied to the clone).
    const loreScan = `${context.map(m => m.content).join("\n")}\n${recallText}`;
    const loreMatches = loreListing?.lorebook?.length ? matchLore(loreListing.lorebook, loreScan) : [];
    if (loreMatches.length) {
      persona.lore = loreMatches.map(e => e.content);
      inc("recall.lore_match");
    }

    // visionClient is always operator-key spend (BYOK users' images run on it
    // too) — so it counts against the hosted:global breaker, not just the
    // scope cap.
    const meteredVision = deps.visionClient
      ? meteredClient(meteredClient(deps.visionClient, { guildId: scope, store, getCap: async () => config.dmLlmDailyCap }), { guildId: "hosted:global", store, getCap: () => deps.fleetCap.getEffective() })
      : undefined;
    // Vision descriptions cache on the archive row — whichever pass (extract
    // job or reply) describes the attachments first is reused by every other.
    let imageContext = cachedImageContext;
    if (!imageContext && images.length && config.visionModel) {
      const imgDescs = (await Promise.all(images.map(async a => {
        try {
          const d = await brain.describeImage({ url: a.url, contextText: event.content, maxBytes: config.imageMaxBytes }, config.visionModel!, meteredVision);
          inc("vision.described");
          return d.description;
        } catch (error) {
          if (error instanceof BudgetExceeded) throw error;
          inc("vision.error"); return undefined;
        }
      }))).filter((d): d is string => !!d);
      imageContext = imgDescs.length ? formatImageContext(imgDescs, freshOwnerName) : undefined;
      if (imageContext) await store.setImageContext(scope, event.messageId, imageContext).catch(() => inc("recall.image_context_error"));
    }

    const toolCtx: ToolCtx = {
      guildId: scope, store, eventStore: deps.eventStore, profileStore: deps.profileStore,
      resolveName: n => lookups.map.get(n.trim().toLowerCase()),
    };
    // Tools (compound web_search etc.) are premium-only on the hosted lane —
    // per-call tool billing can run ~5x a plain reply. BYOK lanes keep tools.
    const toolsWanted = config.replyTools && toolCues(event.content);
    const toolsOn = toolsWanted && (!hostedDm || account?.plan === "premium");
    const dmSeen = new Set(dmMemories.map(m => m.id));
    const { text } = await brain.reply(
      { ...event, authorName: freshOwnerName },
      context,
      [...dmMemories, ...dmSelfMems.filter(m => !dmSeen.has(m.id))],
      profiles,
      relationships,
      config.replyModel,
      toolsOn,
      compSubj,
      { guildName: "Direct Message", ownerName: freshOwnerName, botName: companion.name, isDm: true, companion: persona },
      toolCtx,
      imageContext,
    );
    const clean = text ? scrubMentions(text, lookups.names) : "";
    if (clean && looksLikeSchemaLeak(clean)) {
      inc("reply.schema_leak"); if (!regen) deps.replyThrottle.refund(scope, userId);
      ledger.refund();
      return;
    }
    // Hosted lane screens on the small SAFETY_MODEL (fast, operator spend
    // either way); BYOK keeps screening on the user's own key.
    const dmReplyText = await screenAdoptedReply({
      companion, text: clean, screener: (hostedDm && deps.hostedSafety()) || brain, ledger, lane: "dm",
    });
    if (dmReplyText) {
      const sent = await sendPersona(dmReplyText);
      if (!sent) {
        inc("reply.send_failed");
        if (!regen) deps.replyThrottle.refund(scope, userId);
        ledger.refund();
        return;
      }
      ledger.markReplied();
      inc("reply.sent");
      // Regen edits the existing reply — no new archive row, and the exchange
      // already produced its journal/summary bookkeeping on the first take.
      if (!regen) {
        await store.recordMessage({
          guildId: scope,
          channelId: channel.id,
          messageId: sent.id,
          authorId: compSubj,
          authorName: companion.name,
          content: dmReplyText,
          createdAt: sent.createdAt ?? new Date(),
          mentionsBot: false,
        }, event.messageId, false, true);
        await store.setTriageResults([{ id: sent.id, result: "noise" }]);
        // Deferrable first-person journaling — a failed enqueue must not lose
        // the reply that already landed; the job no-ops on empty exchanges.
        // Free+hosted owners journal on the same hourly cadence as extraction.
        const journalDelay = account?.plan === "free" && hostedDm ? deps.nextHourBoundary() : undefined;
        enqueue(sql, scope, "journal-write", {
          companionId: companion.id, triggerMessageId: event.messageId,
          replyMessageId: sent.id, channelId: channel.id,
        }, journalDelay).catch(() => inc("jobs.enqueue_error"));
        void deps.maybeEnqueueSummary(companion.id, scope, channel.id);
      }
      if (ledger.charged) void deps.maybeAlertLowCredit(userId, ledger.balance);
      // Free+hosted users never see tools — a once-a-day hint that Premium
      // unlocks them is the only way they'd learn the feature exists.
      if (toolsWanted && !toolsOn && account && account.plan !== "premium" && deps.toolsNudgeDue(userId)) {
        inc("premium.tools_nudge");
        channel.send?.(`${companion.name} almost went looking that up — Premium unlocks web search and link-reading: ${config.siteUrl}/dashboard#billing`).catch(() => {});
      }
    } else {
      inc("reply.empty");
      if (!regen) deps.replyThrottle.refund(scope, userId);
      ledger.refund();
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      inc("budget.reply_blocked");
      if (!regen) deps.replyThrottle.refund(scope, userId);
      // The ledger refuses to refund once a reply landed — a bookkeeping
      // throw after send shouldn't claw back a delivered turn.
      ledger.refund();
      if (regen || deps.budgetNoticeOnce(channel.id)) {
        const hostedOut = error.guildId === "hosted:global";
        await sendSystem({ content: hostedOut ? deps.hostedCapacity() : `We've hit today's DM message limit — it resets ${deps.dailyResetTag()}.` });
      }
      return;
    }
    inc("llm.reply_error");
    logError("DM reply generation failed", error);
    if (!regen) deps.replyThrottle.refund(scope, userId);
    ledger.refund();
  } finally {
    stopTyping();
  }
}
