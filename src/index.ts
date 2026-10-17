import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events, GatewayIntentBits, Partials, type Guild, type Message, type OmitPartialGroupDMChannel } from "discord.js";
import OpenAI from "openai";
import { config } from "./config.js";
import { sql } from "./db.js";
import { MemoryStore, type Memory } from "./database.js";
import { createBrainResolver, guardedLlmFetch } from "./brains.js";
import type { Brain } from "./brain.js";
import {
  buildApiKeyOnboardingPayload,
  buildAwakenedCompanionPayload,
  buildOnboardingDraftComponents,
  buildOnboardingDraftEmbed,
  buildOnboardingWelcomePayload,
  commandDefinitions,
  findMutualGuilds,
  handleCompanionModal,
  handleMemoryButton, handleMarketplaceContext, handleMarketSelect,
  handleMemoryCommand,
  handleSetupModal,
  sendAdoptionGreeting,
  scopedCommandDefinitions,
} from "./commands.js";
import { containsPrivateSubtext, looksLikeSchemaLeak, recallTerms, shouldInspectForMemory, toolCues } from "./perception.js";
import { ConversationTracker } from "./conversation.js";
import { ReplyThrottle } from "./reply-throttle.js";
import { EventStore } from "./events.js";
import { EventPipeline } from "./event-detection.js";
import { ProfileStore } from "./profiles.js";
import { buildAliasMap, demangleMentions, findMentionedUsers, scrubMentions, type AliasMap } from "./entity-resolution.js";
import { enqueue, startWorker, FatalJobError, resumeGuildClaims } from "./jobs.js";
import { runPairAnalysisJob, type PairAnalysisPayload } from "./pair-analysis-job.js";
import { buildPairContext, type ToolCtx } from "./lookup-tools.js";
import { qualifyingImages, formatImageContext, IMAGE_MAX_PER_MESSAGE, type AttachmentMeta } from "./vision.js";
import { sleep, withRetry } from "./retry.js";
import { inc } from "./metrics.js";
import { logError, redactSecrets, registerSecret, validateLlmKey } from "./secrets.js";
import { announceIfNeeded, handleGuildDelete } from "./guild-lifecycle.js";
import { isSafeUrl } from "./tools.js";
import { BudgetExceeded, meteredClient } from "./budget.js";
import { runExtractJob, type ExtractJobPayload } from "./extract-job.js";
import { runJournalJob, type JournalJobPayload } from "./journal-job.js";
import { runChatImportJob, type ChatImportJobPayload } from "./chat-import-job.js";
import { greetPendingInstalls } from "./install-greet.js";
import { selectCompanionForTurn } from "./scene-router.js";
import { sendAsCompanion } from "./webhooks.js";
import { isSelfHarmSignal, CRISIS_RESPONSE, SAFE_REFUSAL } from "./safety.js";
import {
  initOps, automodMessage, isHouse, isMarketplaceThread, opsAlert,
  handleHouseMemberAdd, handleHouseMemberUpdate, handleHouseMemberRemove,
  ensureHouseLayout, ensureResourcePosts, ensureTicketPanel, handleTicketModal, startHostWatchdog, ensureVerifyGate, startLinkSweep,
  startTagSweep,
  type OpsDeps, type GuildLike,
} from "./ops.js";
import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { gatherOwnerSubtextForServer, gatherServerDigestForDm } from "./cross-context.js";
import { defaultEmbedder, vectorLiteral } from "./embeddings.js";
import type { CompanionPersona, JournalEntry, MessageEvent, PairContext } from "./types.js";

// Register every credential before any code path can log it — redactSecrets
// scrubs all registered values plus auth-header-shaped tokens out of logs.
registerSecret(config.discordToken);
registerSecret(config.databaseUrl);
registerSecret(config.keyEncryptionSecret);
registerSecret(config.groqKey);
registerSecret(config.visionApiKey);

// Operator-set endpoints still get the SSRF guard — a pasted internal URL
// would otherwise aim every LLM call (carrying the API key) at the wrong host.
for (const [name, url] of [["GROQ_BASE_URL", config.groqBaseUrl], ["VISION_BASE_URL", config.visionBaseUrl]] as const) {
  if (url && !isSafeUrl(url)) {
    console.error(`${name} fails the URL safety check (private/internal host) — refusing to start`);
    process.exit(1);
  }
}

const execAsync = promisify(cpExec);
// Event-loop lag sampler for the host watchdog — index.ts owns the histogram;
// ops.ts reads it through a getter so tests inject their own.
const lagHistogram = monitorEventLoopDelay();
lagHistogram.enable();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    // Privileged — member join/update/remove for house ops only. Gated on
    // HOUSE_GUILD_ID so deployments without house ops never request it; the
    // portal toggle must be on before this ships to prod or login fails.
    ...(config.houseGuildId ? [GatewayIntentBits.GuildMembers] : []),
  ],
  // Reactions on uncached messages arrive as partials — the listener resolves
  // them explicitly before interpreting.
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});
// Per-guild Brain resolver (BYOK): a guild's own key when /setup stored one,
// env key otherwise, null (dormant) when REQUIRE_GUILD_KEYS blocks the fallback.
// `store` is assigned in init() before any resolution can be requested.
const { brainFor, brainForUser, invalidate: invalidateBrain, isHostedScope, isHostedUserBrain } = createBrainResolver({
  getKey: scopeId => store.getGuildKey(scopeId),
  getGuildOwnerIds: async guildId => (await store.listGuildCompanions(guildId)).map(c => c.ownerUserId),
  envKey: config.groqKey, envModel: config.model, envBaseUrl: config.groqBaseUrl,
  requireGuildKeys: config.requireGuildKeys,
  markValidated: scopeId => store.markGuildKeyValidated(scopeId),
  revalidate: async (key, baseUrl) => (await validateLlmKey(key, baseUrl, guardedLlmFetch)).ok,
  // Every LLM call a scope makes — user BYOK or env key — charges its daily budget.
  // getCap reads settings() (60s cache — fine for a daily bound).
  meter: (scopeId, c) => meteredClient(c, {
    guildId: scopeId, store,
    getCap: async () => scopeId.startsWith("dm:")
      ? config.dmLlmDailyCap
      : (await store.settings(scopeId, config.rawMessageRetentionDays)).llmDailyCap,
  }),
  // Hosted lane (env key) additionally charges the fleet-wide circuit breaker —
  // a second metered wrap on scope 'hosted:global' so BYOK calls never count.
  meterHosted: (scopeId, c) => meteredClient(meteredClient(c, {
    guildId: scopeId, store,
    getCap: async () => scopeId.startsWith("dm:")
      ? config.dmLlmDailyCap
      : (await store.settings(scopeId, config.rawMessageRetentionDays)).llmDailyCap,
  }), {
    guildId: "hosted:global", store,
    getCap: async () => config.hostedDailyLlmCap,
  }),
});
// Vision can live on a different provider than the main key (e.g. Gemini's
// free tier, since Groq rotated its vision models off) — a second client is
// built only when the creds actually differ.
const visionClient = config.visionModel &&
  (config.visionApiKey !== config.groqKey || config.visionBaseUrl !== config.groqBaseUrl)
    ? new OpenAI({ apiKey: config.visionApiKey, baseURL: config.visionBaseUrl })
    : undefined;
const pipeline = new EventPipeline();
// Per-channel conversation state: who's actively talking *with* the bot.
// Opens on addressed messages, closes when the last participant leaves —
// TTL expiry, regex dismissal, or the model's end_conversation signal.
const convo = new ConversationTracker(config.engagementTtlMs);
// Per-user reply budget — bounds the worst-case drain a single user can cause
// against the guild's daily LLM cap (a burst is free, then ~1/refill sustained).
const replyThrottle = new ReplyThrottle({ capacity: config.replyBurst, refillMs: config.replyRefillMs });

// ── Account-link gate + hosted credits ───────────────────────────────────────
// Unlinked users get a polite pointer once per cooldown — every other lane
// (/link, key setup, privacy commands, admin commands) stays open. Credits
// only charge on the hosted lane: isHostedScope/isHostedUserBrain tell BYOK
// brains apart so power users' own keys never spend tokens.
const linkPromptedAt = new Map<string, number>();
function linkPromptDue(key: string): boolean {
  const last = linkPromptedAt.get(key) ?? 0;
  if (Date.now() - last < config.linkPromptCooldownMs) return false;
  // Cap-and-clear: an unbounded map grows forever on a busy fleet.
  if (linkPromptedAt.size > 10_000) linkPromptedAt.clear();
  linkPromptedAt.set(key, Date.now());
  return true;
}
const LINK_PROMPT = `To use Characterly's hosted features, create a free account at ${config.siteUrl} and run \`/link\` here to connect it to your Discord — it takes about a minute.`;
const TOKEN_EMPTY = `You're out of tokens — they refresh daily at midnight UTC. Premium refills to 150/day: ${config.siteUrl}/dashboard#billing`;
const HOSTED_CAPACITY = `The hosted model is at today's capacity — it resets at midnight UTC. Bringing your own API key (\`/companion action:key\`) always works.`;

// One "low tokens" DM per user per UTC day.
const lowCreditAlertedAt = new Map<string, string>();
async function maybeAlertLowCredit(userId: string, balance: number): Promise<void> {
  if (balance > config.lowCreditAlert) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lowCreditAlertedAt.get(userId) === today) return;
  const s = await store.userBotSettings(userId).catch(() => ({ c2cEnabled: true, lowCreditAlerts: true }));
  if (!s.lowCreditAlerts) return;
  if (lowCreditAlertedAt.size > 10_000) lowCreditAlertedAt.clear();
  lowCreditAlertedAt.set(userId, today);
  const user = await client.users.fetch(userId).catch(() => null);
  await user?.send(`You're down to ${balance} token${balance === 1 ? "" : "s"} — they refresh daily at midnight UTC. Settings: ${config.siteUrl}/dashboard`).catch(() => {});
  inc("credits.low_alert");
}

// One "your companion almost used a web tool" nudge per user per UTC day —
// free+hosted lanes never see tools, so a rare pointer is the only way they
// learn Premium unlocks them. DM path only: a guild nudge would be public.
const toolsNudgeAt = new Map<string, string>();
function toolsNudgeDue(userId: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (toolsNudgeAt.get(userId) === today) return false;
  if (toolsNudgeAt.size > 10_000) toolsNudgeAt.clear();
  toolsNudgeAt.set(userId, today);
  return true;
}

/** Next UTC hour boundary — free+hosted extraction/journal jobs coalesce here
 * (hourly batches: freshness degraded, not quality). */
function nextHourBoundary(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1));
}

// Refunds are fire-and-forget on the reply path but never silent — a failed
// refund is real money to the user, so a drop gets logged + counted.
const refundTurn = (payerId: string, n: number, reason: string) =>
  store.refundCredits(payerId, n, reason).catch(e => {
    inc("credits.refund_error");
    logError(`credit refund failed for ${payerId} (${reason})`, e);
  });

// MemoryStore.create() runs migrations; EventStore shares the same sql connection.
let store: MemoryStore;
let eventStore: EventStore;
let profileStore: ProfileStore;
let worker: { stop: () => Promise<void> } | undefined;
let watchdog: { stop: () => void } | undefined;
let linkSweep: { stop: () => void } | undefined;
let tagSweep: { stop: () => void } | undefined;

async function init() {
  store = await MemoryStore.create();
  await store.initCreditsSupport({
    freeDaily: config.freeDailyCredits,
    premiumDaily: config.premiumDailyCredits,
  });
  eventStore = new EventStore();
  profileStore = new ProfileStore();
  // Deferrable cognition runs here — extract jobs claimed per-guild-serial,
  // global cap 8. LISTEN 'jobs' for wake hints, 3s poll as the baseline.
  worker = startWorker({
    sql,
    handle: job => {
      if (job.type === "proactive-fire") {
        // Legacy proactive-fire jobs are a no-op: the Characterly bot is pure
        // server plumbing and never speaks on its own.
        return Promise.resolve();
      }
      if (job.type === "pair-analysis") {
        const p = job.payload as PairAnalysisPayload;
        if (!p?.aId || !p.bId) {
          return Promise.reject(new FatalJobError("malformed pair-analysis payload"));
        }
        return runPairAnalysisJob(job.guild_id, p, pairAnalysisDeps);
      }
      if (job.type === "journal-write") {
        return runJournalJob(job.guild_id, job.payload as JournalJobPayload, journalDeps);
      }
      if (job.type === "chat-import") {
        return runChatImportJob(
          job.guild_id, job.payload as ChatImportJobPayload, chatImportDeps, job.attempts,
        );
      }
      // Unknown types are a code bug, not a transient fault — dead-letter
      // immediately rather than retrying something that can never succeed.
      if (job.type !== "extract") {
        inc("jobs.unknown_type");
        return Promise.reject(new FatalJobError(`unknown job type: ${job.type}`));
      }
      return runExtractJob(job.payload as ExtractJobPayload, extractDeps);
    },
    onError: (m, e) => logError(m, e),
  });
}

client.once(Events.ClientReady, async ready => {
  // init failure leaves a connected but braindead bot — exit so supervision
  // restarts it rather than letting it sit mute.
  try {
    await init();
  } catch (error) { logError("Startup init failed", error); process.exit(1); }
  try {
    // Guild + user installs (dev portal): DM-safe commands get the App DM
    // context, server-only ones stay guild-scoped — see scopedCommandDefinitions.
    const scoped = scopedCommandDefinitions(commandDefinitions);
    if (config.guildId) await ready.application.commands.set(scoped, config.guildId);
    else await ready.application.commands.set(scoped);
  } catch (error) { inc("init.commands_error"); logError("Command registration failed", error); }
  // Fire-and-forget: both loops must never reject into the event loop — on
  // Node >=15 an unhandled rejection here is fatal to the process.
  applyRetention().catch(error => { inc("maintenance.error"); logError("Retention run failed", error); });
  sweepMissedSignals(24 * 60 * 60_000).catch(error => { inc("sweep.error"); logError("Boot sweep failed", error); }); // wide window on boot to cover downtime
  if (!config.visionModel) console.warn("[vision] VISION_MODEL unset — image attachments will be ignored");
  // House ops — private layer for OUR community server + this host. initOps
  // runs unconditionally so the /ops console (status/logs/restart/deploy)
  // answers an allowlisted operator's DM even when house config is broken —
  // that's exactly when you'd want the console. The guild-facing pieces
  // (layout, watchdog, boot announce, member ops) stay HOUSE_GUILD_ID-gated.
  initOps(opsDeps);
  const repoDir = config.opsRepoDir.replace(/^~(?=$|\/)/, "$HOME");
  opsDeps.gitSha = await opsDeps.exec(`cd "${repoDir}" && git rev-parse --short HEAD`)
    .then(r => r.stdout.trim()).catch(() => null);
  if (config.houseGuildId) {
    try {
      const house = await opsDeps.fetchGuild(config.houseGuildId);
      if (house) {
        const made = await ensureHouseLayout(house).catch(e => { logError("house layout failed", e); return [] as string[]; });
        const posted = await ensureResourcePosts(opsDeps, house).catch(e => { logError("resource posts failed", e); return [] as string[]; });
        const changed = [...made, ...posted];
        // Ticket panel — the persistent Open-a-ticket card in #support-ticket.
        await ensureTicketPanel(opsDeps, house).catch(e => { inc("ops.init_error"); logError("ticket panel failed", e); return false; });
        if (changed.length) await opsAlert(opsDeps, `🧱 House layout — ${changed.join(", ")}`);
        // Verify gate card — posted once if missing; pending members see it
        // but the button refuses until screening passes.
        await ensureVerifyGate(opsDeps).catch(e => { inc("ops.init_error"); logError("verify gate failed", e); return false; });
      } else {
        logError("house ops init", new Error("HOUSE_GUILD_ID set but the guild isn't reachable"));
      }
      watchdog = startHostWatchdog(opsDeps);
      linkSweep = startLinkSweep(opsDeps); // Member role ↔ account-link reconciliation
      tagSweep = startTagSweep(opsDeps);   // Curated marketplace badges ↔ live stats
      await opsAlert(opsDeps, `🟢 Characterly online — sha \`${opsDeps.gitSha ?? "?"}\` · migrations applied · host watchdog armed`);
    } catch (error) { inc("ops.init_error"); logError("house ops init failed", error); }
  }
  // Backfill Discord display fields for code-linked accounts predating v38 —
  // their claims only stamped discord_user_id. One user fetch per gap, once
  // per boot; afterwards the snapshot rides on web_profiles like OAuth links.
  if (store.creditsSupported) {
    const missing = await store.linkedProfilesMissingDiscordIdentity()
      .catch(e => { inc("ops.init_error"); logError("discord identity backfill scan failed", e); return [] as string[]; });
    for (const discordUserId of missing) {
      const u = await client.users.fetch(discordUserId).catch(() => null);
      if (!u) continue;
      await store.syncDiscordIdentity(discordUserId, u.globalName ?? u.username, u.displayAvatarURL({ size: 64 }))
        .catch(e => { inc("ops.init_error"); logError("discord identity backfill failed", e); });
    }
  }
  console.log(`Characterly online as ${ready.user.tag}`);
});

// ── Guild lifecycle (announce / kick-purge) ─────────────────────────────────
// announceIfNeeded + handleGuildDelete live in guild-lifecycle.ts so they can
// be unit-tested (this module logs in on import).
client.on(Events.GuildCreate, guild => {
  if (!store) return; // fires before init on connect — ClientReady runs first in practice
  resumeGuildClaims(guild.id); // a re-join un-pauses what a kick-purge paused
  announceIfNeeded(guild, store).catch(error => { inc("guild.announce_error"); logError(`Join announcement failed in ${guild.name}`, error); });
});

client.on(Events.GuildDelete, guild => {
  if (!store) return;
  handleGuildDelete(guild as Guild & { unavailable?: boolean }, store)
    .then(purged => { if (purged) { inc("guild.purged"); console.log(`Purged all data for removed guild ${guild.id} (${guild.name})`); } })
    .catch(error => { inc("guild.purge_error"); logError(`Guild purge failed for ${guild.id}`, error); });
});

// ── House member ops ─────────────────────────────────────────────────────────
// GuildMembers is a privileged intent (requested only when HOUSE_GUILD_ID is
// configured). isHouse re-checks inside each handler too — belt and suspenders.
client.on(Events.GuildMemberAdd, member => {
  if (!store || !isHouse(member.guild.id)) return;
  handleHouseMemberAdd(member, opsDeps)
    .catch(e => { inc("ops.member_error"); logError("house member-add failed", e); });
});

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  if (!store || !isHouse(newMember.guild.id)) return;
  handleHouseMemberUpdate(oldMember, newMember, opsDeps)
    .catch(e => { inc("ops.member_error"); logError("house member-update failed", e); });
});

client.on(Events.GuildMemberRemove, member => {
  if (!store || !isHouse(member.guild.id)) return;
  handleHouseMemberRemove(member, opsDeps)
    .catch(e => { inc("ops.member_error"); logError("house member-remove failed", e); });
});

async function applyRetention() {
  // Zombie sweep first: an in-flight write can race a kick-purge and re-insert
  // a server_settings/members row after it commits. Cache is authoritative —
  // discord.js keeps unavailable (outage) guilds cached, so they're never
  // swept. guildsNotIn no-ops on an empty cache (treated as "not ready").
  try {
    const known = client.guilds.cache.map(g => g.id);
    for (const orphanId of await store.guildsNotIn(known)) {
      await store.purgeGuild(orphanId);
      inc("guild.purged");
      console.log(`Purged zombie rows for removed guild ${orphanId}`);
    }
  } catch (error) { inc("maintenance.error"); logError("Zombie-guild sweep failed", error); }
  // Journal cap is global (per companion+scope partition inside) — one pass
  // per maintenance run evicts the least-important stale entries past 200.
  try {
    const pruned = await store.pruneJournal();
    if (pruned) console.log(`Pruned ${pruned} stale companion journal entries`);
  } catch (error) { inc("maintenance.journal_error"); logError("Journal prune failed", error); }
  const dmScopes = await store.listActiveDmScopes().catch(() => [] as string[]);
  const scopes: Array<{ id: string; name: string }> = [
    ...[...client.guilds.cache.values()].map(g => ({ id: g.id, name: g.name })),
    ...dmScopes.map(id => ({ id, name: id })),
  ];
  for (const guild of scopes) {
    // These three calls sit outside the feature-level try/catches below — a DB
    // blip here must skip the guild, not reject the whole interval callback.
    let retentionDays = config.rawMessageRetentionDays;
    try {
      const settings = await store.settings(guild.id, config.rawMessageRetentionDays);
      retentionDays = settings.rawRetentionDays;
      const deleted = await store.deleteRawMessagesOlderThan(guild.id, settings.rawRetentionDays);
      await store.maintain(guild.id, config.candidateConfidenceThreshold);
      if (deleted) console.log(`Retention deleted ${deleted} raw messages in ${guild.name}`);
    } catch (error) { inc("maintenance.retention_error"); logError(`Retention/maintenance failed in ${guild.name}`, error); continue; }
    try {
      const pruned = await store.pruneDerivedData(guild.id, undefined, retentionDays);
      if (pruned.history + pruned.names + pruned.aliases + pruned.events + pruned.usage + pruned.evidence + pruned.observations) {
        console.log(`Pruned derived data in ${guild.name}: ${pruned.history} history, ${pruned.names} unresolved names, ${pruned.aliases} alias candidates, ${pruned.events} events, ${pruned.usage} usage rows, ${pruned.evidence} evidence verbatim, ${pruned.observations} dead relationship observations`);
      }
    } catch (error) { inc("maintenance.prune_error"); logError("Derived-data pruning failed", error); }
    // Hoisted so the relationship rebuild and the pair-analysis enqueue share
    // one archive scan — interactionPairs reads every 90d message.
    let guildInteractions: Array<{ aId: string; bId: string; count: number; firstAt: string; lastAt: string }> = [];
    // Dormant guilds (no key) skip every LLM pass — retention/pruning above
    // still ran; they're lifecycle ops, not cognition.
    const brain = await brainFor(guild.id);
    if (!brain) continue;
    // v0.2: close stale open event windows and score candidate events
    try {
      const result = await pipeline.maintainEvents(guild.id, eventStore, store, brain);
      if (result.closed || result.promoted || result.discarded) {
        console.log(`Events maintained in ${guild.name}: closed=${result.closed} promoted=${result.promoted} discarded=${result.discarded}`);
      }
    } catch (error) { logError("Event maintenance failed", error); }
    // Verify promotable candidate memories against their source messages so edgy
    // jokes don't activate; verified literal self-reports promote. Runs before
    // the profile build so cards and dossiers see final statuses.
    try {
      const verifiable = await store.listVerifiableCandidates(guild.id);
      let vPromoted = 0, vFlagged = 0;
      for (let i = 0; i < verifiable.length; i += 10) {
        const batch = verifiable.slice(i, i + 10);
        const verdicts = await brain.verifyMemoriesBatch(
          batch.map(b => ({ memoryId: b.memoryId, authorName: b.authorName, authorNames: b.authorNames, claim: b.content, sourceMessage: b.sourceMessage, contextBefore: b.contextBefore })),
          config.verifyModel
        );
        for (const b of batch) {
          const v = verdicts.get(b.memoryId);
          if (!v) continue;
          const r = await store.applyVerification(b.memoryId, v.verdict, v.reason);
          if (r === "promoted") vPromoted++;
          else if (r === "flagged") vFlagged++;
        }
      }
      if (vPromoted || vFlagged) console.log(`Verified candidates in ${guild.name}: ${vPromoted} promoted, ${vFlagged} flagged as jokes`);
    } catch (error) { logError("Verification failed", error); }
    // Verify unverified relationship observations, then rebuild edges — the
    // relationships table is derived from 'literal'-verdicted observations
    // only, so unverified assertions never surface as edges. Recompute runs
    // every pass so opted-out deletions and pre-existing edges stay consistent.
    try {
      const unverified = await store.listUnverifiedObservations(guild.id, 50);
      let judged = 0;
      for (let i = 0; i < unverified.length; i += 10) {
        const batch = unverified.slice(i, i + 10);
        const items = await Promise.all(batch.map(async b => ({
          observationId: b.observationId, authorName: b.authorName, authorNames: b.authorNames,
          nature: b.nature, otherName: await store.displayNameFor(guild.id, b.otherId),
          sourceMessage: b.sourceMessage, contextBefore: b.contextBefore,
        })));
        const verdicts = await brain.verifyRelationshipsBatch(
          items,
          config.verifyModel
        );
        for (const b of batch) {
          const v = verdicts.get(b.observationId);
          if (v) { await store.setObservationVerdict(b.observationId, v.verdict); judged++; }
        }
      }
      // The deterministic interaction graph feeds the edge rebuild: stamped
      // onto claimed edges as behavioral support, and frequent-contact pairs
      // with no claims materialize as inferred edges. Computed once — the
      // pair-analysis enqueue below reuses the same list.
      const aliasMap = (await guildLookups(guild.id)).map;
      const companionSubjects = (await store.listGuildCompanions(guild.id)).map(c =>
        MemoryStore.companionSubjectId(c.id),
      );
      // Ignored channels are invisible to the interaction graph too, and other
      // bots' rows don't form pairs — allowBotIds admits summoned companions.
      guildInteractions = await store.interactionPairs(guild.id, aliasMap, {
        excludeChannels: (await store.settings(guild.id, config.rawMessageRetentionDays)).ignoredChannels,
        allowBotIds: companionSubjects,
      });
      const edgeCount = await store.recomputeEdges(guild.id, guildInteractions);
      if (unverified.length) console.log(`Verified ${judged} relationship observations in ${guild.name}; recomputed ${edgeCount} edges`);
    } catch (error) { logError("Relationship verification failed", error); }
    // Pair-analysis: durable holistic reads of the busiest pairs' exchange
    // windows — most real relationships are never verbalized, so single-message
    // extraction can't see them. Both parties must consent (it reads both
    // people's messages), throttled to one read per pair per 7d and only when
    // new interaction happened since, capped at 5 enqueues per pass.
    try {
      const consented = new Set(
        (await store.listMembers(guild.id)).filter(m => m.optedIn && !m.optedOut).map(m => m.userId)
      );
      for (const c of await store.listGuildCompanions(guild.id)) {
        consented.add(MemoryStore.companionSubjectId(c.id));
      }
      let enqueued = 0;
      for (const p of guildInteractions) {
        if (enqueued >= 5 || p.count < 10) break; // sorted desc — the tail is thinner
        if (!consented.has(p.aId) || !consented.has(p.bId)) continue;
        const last = await store.lastPairWindowAt(guild.id, p.aId, p.bId);
        const lastMs = last ? new Date(last).getTime() : 0;
        if (lastMs && Date.now() - lastMs < 7 * 86_400_000) continue;
        if (lastMs && new Date(p.lastAt).getTime() <= lastMs) continue;
        // The throttle only sees written observations — a queued-but-unrun job
        // is invisible to it, so check the queue before enqueueing a duplicate.
        if (await store.hasPendingPairAnalysis(guild.id, p.aId, p.bId)) continue;
        await enqueue(sql, guild.id, "pair-analysis", { aId: p.aId, bId: p.bId });
        enqueued++;
      }
      if (enqueued) console.log(`Queued ${enqueued} pair-analysis jobs in ${guild.name}`);
    } catch (error) { inc("pair_analysis.enqueue_error"); logError("Pair-analysis enqueue failed", error); }
    // Semantic dedup — the LLM scans each member's memory list for rephrased
    // duplicates the trigram fast-path can't see ("allergic to peanuts" /
    // "can't eat nuts"). It proposes groups; applyDedupGroups enforces
    // same-subject/kind, live-status guards and merges into a canonical row.
    try {
      const members = await store.listDedupCandidates(guild.id);
      if (members.length) {
        let index = 0;
        const idByIndex = new Map<number, number>();
        const indexed = members.map(m => ({
          label: m.label,
          memories: m.memories.map(mm => { const i = index++; idByIndex.set(i, mm.memoryId); return { index: i, kind: mm.kind, status: mm.status, content: mm.content }; }),
        }));
        const groups = await brain.dedupMemoriesBatch(indexed, config.verifyModel);
        const dupGroups = groups.filter(g => g.relation === "duplicate")
          .map(g => ({ ids: g.indices.map(i => idByIndex.get(i)).filter((x): x is number => x !== undefined), reason: g.reason }));
        const { merged, skipped } = await store.applyDedupGroups(guild.id, dupGroups);
        let contradictions = 0;
        for (const g of groups) {
          if (g.relation !== "contradicts") continue;
          const ids = g.indices.map(i => idByIndex.get(i)).filter((x): x is number => x !== undefined);
          for (const id of ids) {
            await store.logHistory(id, "dedup_contradiction", null, null, null, null, null, { otherIds: ids.filter(x => x !== id), reason: g.reason });
          }
          contradictions++;
        }
        if (merged || skipped || contradictions) console.log(`Dedup in ${guild.name}: ${merged} merged | ${skipped} groups skipped | ${contradictions} contradictions logged`);
        inc("dedup.merged", merged);
      }
    } catch (error) { logError("Dedup pass failed", error); inc("dedup.errors"); }
    // v0.3: rebuild per-chatter profile cards + dossiers (LLM calls only when inputs changed)
    try {
      const profiles = await profileStore.buildProfiles(guild.id, brain, store, eventStore, config.profileModel, { excludeIds: [client.user!.id] });
      if (profiles.built) console.log(`Profiles in ${guild.name}: ${profiles.built} rebuilt, ${profiles.unchanged} unchanged of ${profiles.considered}`);
    } catch (error) { logError("Profile build failed", error); }
  }
}
// Belt-and-braces: every guild body is try/caught, but an interval callback
// rejection would still be an unhandled (fatal) rejection.
setInterval(() => applyRetention().catch(error => { inc("maintenance.error"); logError("Retention run failed", error); }), 24 * 60 * 60 * 1000).unref();

const SWEEP_INTERVAL_MS = 15 * 60_000;
const SWEEP_WINDOW_MS = 2 * 60 * 60_000;
const SWEEP_TRIAGE_BATCH = 10;

setInterval(() => sweepMissedSignals(SWEEP_WINDOW_MS), SWEEP_INTERVAL_MS).unref();
// Embedding backfill — bounded batch of NULL-embedding rows per tick, so the
// pre-v40 corpus and any inline-embed failures converge without a one-shot job.
setInterval(() => embedBackfill().catch(e => { inc("embed.backfill_error"); logError("embed backfill failed", e); }), SWEEP_INTERVAL_MS).unref();

// Install greeting — app_installs rows land via the Discord webhook-events
// endpoint; this sweep sends the welcome DM to each ungreeted install.
const INSTALL_GREET_INTERVAL_MS = 20_000;
const installGreetDeps = {
  fetchUser: (userId: string) => client.users.fetch(userId),
  hasCompanion: async (userId: string) => !!(await store?.getCompanionByOwner(userId).catch(() => null)),
};
setInterval(() => {
  if (!client.isReady()) return;
  greetPendingInstalls(store, installGreetDeps).catch(e => { inc("install.greet_error"); logError("install greet sweep failed", e); });
}, INSTALL_GREET_INTERVAL_MS).unref();

/** Backfill embeddings for rows saved before v40 or during embed outages.
 * Bounded batch per sweep tick — large corpora converge over several ticks.
 * No-op when the embedder is disabled. */
async function embedBackfill(batchSize = 150): Promise<void> {
  const emb = defaultEmbedder();
  if (!emb.enabled) return;
  let done = 0;
  for (const row of await store.unembeddedMemories(batchSize)) {
    const v = await emb.embed(row.content);
    if (v) { await store.setMemoryEmbedding(row.id, vectorLiteral(v)); done++; }
  }
  for (const row of await store.unembeddedJournal(batchSize)) {
    const v = await emb.embed(row.content);
    if (v) { await store.setJournalEmbedding(row.id, vectorLiteral(v)); done++; }
  }
  if (done) inc("embed.backfilled", done);
}

// Live traffic that fails the durableSignals regex is never inspected inline —
// this sweep gives it the same LLM triage ingest already uses, so durable
// preferences in unpatterned phrasing ("can you just call me Riley from now on",
// said to nobody in particular) still land within ~15 minutes. Marks persist on
// messages.triage_result, so each message is classified once; durable/regex
// verdicts enqueue 'extract' jobs and flip to 'queued' (a failed enqueue keeps
// the mark so the next pass retries — crash-safe), and 'extracted' marks the
// terminal state so empty results don't re-extract forever.
async function sweepMissedSignals(windowMs: number) {
  const dmScopes = await store.listActiveDmScopes().catch(() => [] as string[]);
  const scopes: Array<{ id: string; name: string }> = [
    ...[...client.guilds.cache.values()].map(g => ({ id: g.id, name: g.name })),
    ...dmScopes.map(id => ({ id, name: id })),
  ];
  for (const guild of scopes) {
    try {
      const settings = await store.settings(guild.id, config.rawMessageRetentionDays);
      if (!settings.memoryEnabled) continue;
      // No key → nothing to triage or extract with — skip the guild entirely.
      const brain = await brainFor(guild.id);
      if (!brain) continue;
      // Repair 'queued' marks whose jobs vanished (dormant-drop, crash) or
      // dead-lettered — orphaned marks would otherwise strand messages forever.
      const repaired = await store.repairQueuedMarks(guild.id);
      if (repaired.rejoined) inc("jobs.marks_rejoined", repaired.rejoined);
      if (repaired.dead) inc("jobs.marks_dead", repaired.dead);
      if (repaired.requeued) inc("jobs.marks_requeued", repaired.requeued);
      const pending = (await store.listUninspectedMessages(guild.id, new Date(Date.now() - windowMs), client.user!.id))
        .filter(m => !settings.ignoredChannels.includes(m.channelId)); // ignored = invisible, including rows archived before the flag
      if (!pending.length) continue;
      const toEvent = (m: (typeof pending)[number]): MessageEvent => ({
        guildId: guild.id, channelId: m.channelId, messageId: m.id,
        authorId: m.authorId, authorName: m.authorName, content: m.content,
        createdAt: new Date(m.createdAt),
        mentionsBot: m.content.includes(`<@${client.user!.id}>`) || m.content.includes(`<@!${client.user!.id}>`),
      });
      const marks: Array<{ id: string; result: string }> = [];
      const toEnqueue: Array<{ event: MessageEvent; replyToId?: string }> = [];
      const triageQueue: typeof pending = [];
      for (const m of pending) {
        const event = toEvent(m);
        if (m.triageResult === "durable" || m.triageResult === "regex") {
          toEnqueue.push({ event, replyToId: m.replyToId ?? undefined }); // marked earlier but never extracted
        } else if (shouldInspectForMemory(event)) {
          marks.push({ id: m.id, result: "regex" });
          toEnqueue.push({ event, replyToId: m.replyToId ?? undefined });
        } else if (m.content.trim().length >= 4) {
          triageQueue.push(m);
        } else {
          marks.push({ id: m.id, result: "noise" });
        }
      }
      for (let i = 0; i < triageQueue.length; i += SWEEP_TRIAGE_BATCH) {
        const batch = triageQueue.slice(i, i + SWEEP_TRIAGE_BATCH);
        try {
          const verdicts = await withRetry(() => brain.triageBatch(
            batch.map(b => ({ messageId: b.id, authorName: b.authorName, content: b.content })),
            config.triageModel
          ), 3);
          for (const item of batch) {
            const durable = verdicts.get(item.id)?.durable ?? false;
            marks.push({ id: item.id, result: durable ? "durable" : "noise" });
            if (durable) toEnqueue.push({ event: toEvent(item), replyToId: item.replyToId ?? undefined });
          }
        } catch { /* batch stays unmarked — next sweep retries it */ }
      }
      // Persist marks before enqueueing: durable/regex marks survive a crash
      // and are picked back up on the next pass via the no-evidence filter.
      await store.setTriageResults(marks);
      if (!toEnqueue.length) continue;
      // Extraction defers to the job queue — the sweep's role is triage, and
      // routing through the queue gets per-guild serial execution, backoff,
      // and budget-aware rescheduling for free. A failed enqueue leaves the
      // durable mark in place so the next pass retries.
      const queuedMarks: Array<{ id: string; result: string }> = [];
      // Same free+hosted hourly coalescing as the live path — swept authors
      // are carried on each event; brainFor above already warmed hostedScopes.
      const hostedScope = isHostedScope(guild.id);
      for (const item of toEnqueue) {
        let replyToContent: string | undefined;
        if (item.replyToId) {
          const ref = await store.getMessage(guild.id, item.replyToId);
          if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
        }
        try {
          const acct = hostedScope ? await store.accountForDiscordUser(item.event.authorId).catch(() => null) : null;
          const throttleMemory = hostedScope && (!acct || acct.plan === "free");
          await enqueue(sql, guild.id, "extract", { event: item.event, replyToId: item.replyToId, replyToContent }, throttleMemory ? nextHourBoundary() : undefined);
          queuedMarks.push({ id: item.event.messageId, result: "queued" });
        } catch (error) { inc("jobs.enqueue_error"); logError("Sweep enqueue failed", error); }
      }
      if (queuedMarks.length) await store.setTriageResults(queuedMarks);
      inc("sweep.runs");
    } catch (error) { inc("sweep.error"); logError(`Missed-signal sweep failed in ${guild.name}`, error); }
  }
}

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) await handleMemoryCommand(interaction, store, brainFor, eventStore, profileStore);
    if (interaction.isMessageContextMenuCommand()) await handleMarketplaceContext(interaction, store);
    if (interaction.isStringSelectMenu()) await handleMarketSelect(interaction, store);
    if (interaction.isModalSubmit()) {
      await handleSetupModal(interaction, store, invalidateBrain);
      await handleCompanionModal(interaction, store, scopeId => lookupCache.delete(scopeId));
      await handleTicketModal(interaction);
    }
    if (interaction.isButton()) await handleMemoryButton(interaction, store, brainFor, eventStore);
  } catch (error) {
    inc("handler.interaction_error");
    logError("Interaction handling failed", error);
    // Best-effort user-facing error; ignore failures (already replied/expired).
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Something went wrong handling that.", ephemeral: true });
      }
    } catch { /* interaction no longer replyable */ }
  }
});

client.on(Events.MessageCreate, message => {
  // Outer catch lives here, not inline: an unhandled rejection in a listener
  // crashes the process, so every failure mode lands in this log instead.
  handleMessage(message).catch(error => { inc("handler.message_error"); logError("Message handling failed", error); });
});

// Edits update the archive row; the extraction-time snapshot in memory_evidence
// is deliberately left alone — it's the record of what was observed, not a
// mirror of current content.
client.on(Events.MessageUpdate, (_old, message) => {
  if (!store) return; // before init() completes — a sync TypeError would escape .catch
  if (!message.guild || !message.content?.trim()) return;
  if (config.guildId && message.guild.id !== config.guildId) return;
  store.updateMessageContent(message.guild.id, message.id, message.content)
    .catch(error => { inc("handler.message_error"); logError("Message update handling failed", error); });
});

// Deletes remove the raw row (so the sweep never extracts deleted content)
// and scrub the verbatim text on any evidence it already produced.
client.on(Events.MessageDelete, message => {
  if (!store) return;
  if (!message.guild) return;
  if (config.guildId && message.guild.id !== config.guildId) return;
  store.deleteMessage(message.guild.id, message.id)
    .catch(error => { inc("handler.message_error"); logError("Message delete handling failed", error); });
});

// Alias maps are shared per guild rather than built per message — the same map
// object also feeds the compiled-regex cache in entity-resolution, so caching it
// means the alternation pattern compiles once per rebuild, not per message.
// learnAlias invalidates immediately; display-name drift via upsertMember is
// bounded by the TTL. The same cache carries an id→display-name map used to
// demangle <@id> tokens before they reach the LLM.
const lookupCache = new Map<string, { map: AliasMap; names: Map<string, string>; at: number }>();
const LOOKUP_TTL_MS = 5 * 60_000;

// BudgetExceeded on the reply path → one short notice per channel per UTC
// day: silence on a direct request is rude, spam is worse. In-memory —
// a restart re-noticing once is harmless.
// Bounded once-per-day set — keys carry a date suffix so they never expire
// naturally; cap at a few hundred channels and evict insertion-oldest.
const NOTICE_CAP = 512;
function noticeOnce(set: Set<string>, channelId: string): boolean {
  const key = `${channelId}:${new Date().toISOString().slice(0, 10)}`;
  if (set.has(key)) return false;
  if (set.size >= NOTICE_CAP) set.delete(set.values().next().value!);
  set.add(key);
  return true;
}

const budgetNotices = new Set<string>();
function budgetNoticeOnce(channelId: string): boolean {
  return noticeOnce(budgetNotices, channelId);
}

const noCompanionNotices = new Set<string>();
function noCompanionNoticeOnce(channelId: string): boolean {
  return noticeOnce(noCompanionNotices, channelId);
}

async function guildLookups(guildId: string): Promise<{ map: AliasMap; names: Map<string, string> }> {
  const cached = lookupCache.get(guildId);
  if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached;
  const [map, members] = await Promise.all([buildAliasMap(guildId, store), store.listMembers(guildId)]);
  const names = new Map<string, string>();
  for (const m of members) names.set(m.userId, m.knownNames.at(-1) ?? m.userId);
  if (client.user) names.set(client.user.id, client.user.username);
  const entry = { map, names, at: Date.now() };
  lookupCache.set(guildId, entry);
  return entry;
}

// The extract-job handler lives in extract-job.ts (deps injected) so it's
// unit-testable — index.ts can't be imported (it logs in on load). The worker
// deps bind this process's live singletons; getAliases/invalidateLookups close
// over the TTL lookup cache.
const extractDeps = {
  get store() { return store; },
  brainFor,
  get eventStore() { return eventStore; },
  pipeline,
  get botId() { return client.user!.id; },
  get visionModel() { return config.visionModel; },
  visionClient,
  get contestModel() { return config.contestModel; },
  get imageMaxBytes() { return config.imageMaxBytes; },
  get dmLlmDailyCap() { return config.dmLlmDailyCap; },
  get hostedDailyCap() { return config.hostedDailyLlmCap; },
  getAliases: (guildId: string) => guildLookups(guildId).then(e => e.map),
  invalidateLookups: (guildId: string) => { lookupCache.delete(guildId); },
};

// Same deps-injection pattern as extractDeps — the handler lives outside
// index.ts for testability; these close over the live singletons.
const pairAnalysisDeps = {
  get store() { return store; },
  brainFor,
  getAliases: (guildId: string) => guildLookups(guildId).then(e => e.map),
  get botId() { return client.user!.id; },
  get analysisModel() { return config.verifyModel; },
};

// Journal-write jobs — same deps-injection pattern; the companion's
// first-person journal is written off the live reply path.
const journalDeps = {
  get store() { return store; },
  brainFor,
  get botId() { return client.user!.id; },
};

// Chat-import jobs — transcript distillation off the import path. sendDm is
// the completion note; users.send fetches first so a cold cache still lands.
const chatImportDeps = {
  get store() { return store; },
  brainFor,
  maxWindows: config.chatImportMaxWindows,
  windowSize: 30,
  sendDm: async (userId: string, content: string) => {
    const u = await client.users.fetch(userId);
    await u.send(content);
  },
};

// House ops — same deps-injection pattern. exec/exit are real here, faked in
// tests; lagMs samples + resets the shared histogram so each tick reports
// the lag accumulated since the last read.
const opsDeps: OpsDeps = {
  get store() { return store; },
  // Cache-first — welcome posts and automod alerts would otherwise REST-fetch
  // the same channel on every join/message during a raid.
  fetchChannel: async id => {
    const cached = client.channels.cache.get(id);
    if (cached?.isTextBased() && "send" in cached) return cached as unknown as { send(p: unknown): Promise<unknown> };
    const c = await client.channels.fetch(id).catch(() => null);
    return c?.isTextBased() && "send" in c ? c as unknown as { send(p: unknown): Promise<unknown> } : null;
  },
  fetchGuild: id => client.guilds.fetch(id).then(g => g as unknown as GuildLike).catch(() => null),
  fetchMember: async (guildId, userId) => {
    const g = await client.guilds.fetch(guildId).catch(() => null);
    if (!g) return null;
    return g.members.fetch(userId).then(m => m as unknown as import("./ops.js").MemberLike).catch(() => null);
  },
  listMembers: async guildId => {
    const g = await client.guilds.fetch(guildId).catch(() => null);
    if (!g) return [];
    // members.list caps at 1000/page — plenty for the house server.
    const coll = await g.members.list({ limit: 1000 }).catch(() => null);
    return coll ? [...coll.values()] as unknown as import("./ops.js").MemberLike[] : [];
  },
  get botId() { return client.user?.id ?? null; },
  // Bounded: a stalled `git pull` or hung `npm ci` must not freeze the /ops
  // console forever — a timeout lands as a catchable error instead.
  exec: cmd => execAsync(cmd, { maxBuffer: 4 * 1024 * 1024, timeout: 300_000 }),
  exit: code => process.exit(code),
  dbPing: async () => { const t = Date.now(); await sql`SELECT 1`; return Date.now() - t; },
  lagMs: () => { const ms = lagHistogram.mean / 1e6; lagHistogram.reset(); return ms; },
  gitSha: null,
};

/** Prompt memory recall: the static spine (relevantMemories — top-N by
 * importance×confidence) merged with turn-aware contextual hits — a memory
 * below the spine cap still surfaces when the current message is about it.
 * The same consent/candidate gates apply on both legs. */
async function promptMemories(scope: string, subjectId: string, text: string, vec: number[] | null): Promise<Memory[]> {
  const spine = await store.relevantMemories(scope, subjectId);
  const terms = recallTerms(text);
  let contextual: Memory[] = [];
  let semantic: Memory[] = [];
  // try/catch (not .catch) — stubbed stores in tests may lack the methods
  // entirely, which throws synchronously at the call site.
  if (terms.length) {
    try {
      contextual = await store.contextualMemories(scope, subjectId, terms);
    } catch (e) {
      inc("recall.context_error");
      logError("contextual memory recall failed", e);
    }
  }
  if (vec) {
    try {
      semantic = await store.semanticMemories(scope, subjectId, vectorLiteral(vec), { maxDistance: config.embedMaxDistance });
    } catch (e) {
      inc("recall.semantic_error");
      logError("semantic memory recall failed", e);
    }
  }
  const seen = new Set(spine.map(m => m.id));
  const merged = [...spine];
  for (const m of [...contextual, ...semantic]) {
    if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
  }
  return merged;
}

/** Journal recall: journalFor's static top-N plus semanticJournal hits
 * against the current turn — a relevant moment below the importance cap
 * still surfaces when the conversation drifts onto it. Origin scope and the
 * opt-out filter are identical on both legs; embedder-disabled ⇒ spine only. */
async function promptJournal(
  companionId: number,
  scope: string,
  aboutIds: string[],
  vec: number[] | null,
): Promise<JournalEntry[]> {
  const spine = await store.journalFor(companionId, scope, { aboutIds }).catch(() => [] as JournalEntry[]);
  let semantic: JournalEntry[] = [];
  if (vec) {
    try {
      semantic = await store.semanticJournal(companionId, scope, vectorLiteral(vec), { aboutIds, maxDistance: config.embedMaxDistance });
    } catch (e) {
      inc("recall.semantic_journal_error");
      logError("semantic journal recall failed", e);
    }
  }
  const seen = new Set(spine.map(j => j.id));
  return [...spine, ...semantic.filter(j => !seen.has(j.id))].slice(0, 10);
}

async function handleDmMessage(
  message: OmitPartialGroupDMChannel<Message>,
  images: Array<AttachmentMeta & { contentType: string }>,
) {
  if (message.author.bot) return;
  const rawAvatarAttachment = [...message.attachments.values()].find(a =>
    a.contentType?.startsWith("image/") && a.size <= config.imageMaxBytes,
  );
  if (!message.content.trim() && !images.length && !rawAvatarAttachment) return;

  const userId = message.author.id;
  const dmScope = `dm:${userId}`;
  const authorName = message.author.globalName ?? message.author.username;
  // Link gate: hosted features need a Characterly account — but a personal
  // key is its own lane, so BYOK users work unlinked. Everyone else gets the
  // prompt once per cooldown; nothing else (not even onboarding) runs.
  const account = await store.accountForDiscordUser(userId);
  if (!account && store.creditsSupported) {
    const ownKey = await store.getGuildKey(dmScope).catch(() => null);
    if (!ownKey) {
      if (linkPromptDue(`dm:${userId}`)) {
        await message.reply({ content: LINK_PROMPT, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
        inc("gate.unlinked_dm");
      }
      return;
    }
  }
  const brain = await brainFor(dmScope);
  if (!brain) {
    if (config.keyEncryptionSecret && replyThrottle.consume(dmScope, userId)) {
      await message.reply({
        ...buildApiKeyOnboardingPayload(userId),
        allowedMentions: { parse: [], repliedUser: false },
      }).catch(() => {});
    }
    return;
  }

  // Resolve who answers: the user's active DM pick (adopted or awakened),
  // falling back to the awakened companion/onboarding draft. `existing` stays
  // the awakened row so onboarding behaves exactly as before.
  const existing = await store.getCompanionByOwner(userId);
  const dmCompanion = await store.resolveDmCompanion(userId).catch(() => null);
  const activeCompanion = dmCompanion ?? existing;
  const replyToId = message.reference?.messageId ?? undefined;

  // ── 1:1 DM Conversational Onboarding ───────────────────────────────────────
  if (!activeCompanion || activeCompanion.onboardingState !== "active") {
    if (!replyThrottle.consume(dmScope, userId)) { inc("reply.cooldown"); return; }
    try {
      await message.channel.sendTyping();
      const recent = await store.recentContext(dmScope, message.channel.id, 12);
      const transcript = recent.map(r => ({
        authorName: r.authorName,
        isBot: r.authorId === client.user!.id || r.authorId.startsWith("companion:"),
        content: r.content,
      }));
      const event: MessageEvent = {
        guildId: dmScope,
        channelId: message.channel.id,
        messageId: message.id,
        authorId: userId,
        authorName,
        content: message.content || "(attached an image)",
        createdAt: message.createdAt,
        mentionsBot: true,
      };
      await store.recordMessage(event, replyToId, false, false);
      await store.setTriageResults([{ id: event.messageId, result: "noise" }]);

      const avatarUrl = rawAvatarAttachment?.url ?? existing?.avatarUrl ?? null;
      const turn = await brain.runOnboardingTurn({
        ownerName: authorName,
        userMessage: message.content || "(sent an avatar image)",
        transcript,
        currentDraft: existing
          ? {
              name: existing.name,
              voicePersona: existing.voicePersona,
              coreTraits: existing.coreTraits,
              ownerDynamic: existing.ownerDynamic,
              backstory: existing.backstory,
              avatarUrl,
            }
          : { avatarUrl },
        turnCount: existing?.onboardingTurns ?? 0,
        hasImageAttachment: Boolean(rawAvatarAttachment),
        model: config.replyModel,
      });

      let companionName = turn.spec.name || existing?.name || client.user!.username;
      let companionAuthorId = client.user!.id;
      let replyExtras: { embeds?: any[]; components?: any[] } = {};
      if (turn.complete) {
        const activated = await store.activateCompanion(userId, authorName, {
          ...turn.spec,
          avatarUrl,
        });
        companionName = activated.name;
        companionAuthorId = MemoryStore.companionSubjectId(activated.id);
        lookupCache.delete(dmScope);
        inc("companion.awakened");
        replyExtras = buildAwakenedCompanionPayload(
          activated,
          authorName,
          findMutualGuilds(client, userId),
        );
      } else {
        const updatedDraft = await store.upsertCompanionOnboarding(
          userId,
          { ...turn.spec, avatarUrl },
          true,
        );
        inc("companion.onboarding_turn");
        const isBlankColdStart =
          (existing?.onboardingTurns ?? 0) === 0 &&
          !updatedDraft.name &&
          !updatedDraft.voicePersona &&
          !updatedDraft.ownerDynamic;
        replyExtras = isBlankColdStart
          ? buildOnboardingWelcomePayload(userId)
          : {
              embeds: [buildOnboardingDraftEmbed(updatedDraft, updatedDraft.onboardingTurns)],
              components: [buildOnboardingDraftComponents(userId, updatedDraft)],
            };
      }

      const sent = await message.reply({
        content: turn.replyText,
        ...replyExtras,
        allowedMentions: { parse: [], repliedUser: false },
      });
      await store.recordMessage({
        guildId: dmScope,
        channelId: message.channel.id,
        messageId: sent.id,
        authorId: companionAuthorId,
        authorName: companionName,
        content: turn.replyText,
        createdAt: sent.createdAt ?? new Date(),
        mentionsBot: false,
      }, message.id, false, true);
      await store.setTriageResults([{ id: sent.id, result: "noise" }]);
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        inc("budget.reply_blocked");
        replyThrottle.refund(dmScope, userId);
        if (budgetNoticeOnce(message.channel.id)) {
          await message.reply({ content: "We've hit today's DM message limit — it resets at midnight UTC.", allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
        }
        return;
      }
      inc("llm.reply_error");
      logError("DM onboarding turn failed", error);
      replyThrottle.refund(dmScope, userId);
    }
    return;
  }

  // ── Active 1:1 DM Companion Chat ───────────────────────────────────────────
  const companion = activeCompanion;
  // An adopted companion selected in the marketplace without reachable DMs
  // introduces itself on first contact here — only a successful send counts.
  if (companion.kind === "adopted") {
    const adoption = await store.adoptionForCompanion(companion.id).catch(() => null);
    if (adoption && !adoption.dmIntroducedAt) {
      const listing = companion.adoptedFromListingId
        ? await store.listingById(companion.adoptedFromListingId).catch(() => null)
        : null;
      const greeted = await sendAdoptionGreeting(message.author, companion, listing?.greeting ?? "");
      if (greeted) await store.markDmIntroduced(adoption.id).catch(() => {});
    }
  }
  const compSubj = MemoryStore.companionSubjectId(companion.id);
  const event: MessageEvent = {
    guildId: dmScope,
    channelId: message.channel.id,
    messageId: message.id,
    authorId: userId,
    authorName,
    content: message.content,
    createdAt: message.createdAt,
    mentionsBot: true,
    imageAttachments: images.length ? images : undefined,
  };

  const settings = await store.settings(dmScope, config.rawMessageRetentionDays);
  if (!settings.memoryEnabled && !settings.replyEnabled) return;
  if (settings.memoryEnabled) {
    await store.recordMessage(event, replyToId, true, false);
  }

  let replyToContent: string | undefined;
  if (replyToId) {
    const ref = await store.getMessage(dmScope, replyToId);
    if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
  }

  if (settings.memoryEnabled && (shouldInspectForMemory(event) || images.length)) {
    try {
      // Free+hosted memory settles in hourly batches; premium/BYOK is live.
      const throttleMemory = account?.plan === "free" && isHostedScope(dmScope);
      await enqueue(sql, dmScope, "extract", { event, replyToId, replyToContent }, throttleMemory ? nextHourBoundary() : undefined);
      await store.setTriageResults([{ id: event.messageId, result: "queued" }]);
      inc("jobs.enqueued");
    } catch (error) { inc("jobs.enqueue_error"); logError("DM extraction enqueue failed", error); }
  }

  if (!settings.replyEnabled) return;

  // Self-harm triage fires before any spend or throttle — the message is
  // already recorded (extraction can still remember the disclosure), but the
  // reply is a scripted crisis response, not a generation. No judgment call.
  if (isSelfHarmSignal(message.content)) {
    inc("safety.crisis");
    await message.reply({ content: CRISIS_RESPONSE, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
    return;
  }

  if (!replyThrottle.consume(dmScope, userId)) { inc("reply.cooldown"); return; }

  // Hosted lane bills the turn upfront: the human pays for their message +
  // the companion's reply (2 credits); a reply that never sends refunds 1.
  const hostedDm = isHostedScope(dmScope);
  let chargedDm = 0;
  let dmBalance = 0;
  let dmReplied = false;
  if (hostedDm) {
    // Premium priority under fleet pressure: past ~90% of the hosted:global
    // cap the free lane sheds first — premium keeps spending until the hard
    // cap trips inside the metered wrap.
    if (account?.plan !== "premium" && (await store.hostedUsageToday()) >= config.hostedDailyLlmCap * 0.9) {
      inc("gate.hosted_pressure");
      replyThrottle.refund(dmScope, userId);
      if (budgetNoticeOnce(message.channel.id)) {
        await message.reply({ content: HOSTED_CAPACITY, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
      }
      return;
    }
    const spend = await store.spendCredits(userId, 2, "dm_turn");
    if (!spend.ok) {
      inc("credits.insufficient");
      replyThrottle.refund(dmScope, userId);
      if (budgetNoticeOnce(message.channel.id)) {
        // A cached account can outlive a dashboard unlink by a minute — the
        // live miss above evicted it, so a re-check says which notice fits.
        const stillLinked = await store.accountForDiscordUser(userId).catch(() => null);
        await message.reply({ content: stillLinked ? TOKEN_EMPTY : LINK_PROMPT, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
      }
      return;
    }
    chargedDm = 2;
    dmBalance = spend.balance;
  }

  try {
    await message.channel.sendTyping();
    const lookups = await guildLookups(dmScope);
    const peopleIds = [userId, compSubj];
    const profileRows = await profileStore.getProfiles(dmScope, peopleIds);
    const attrMap = await store.attributesForSubjects(dmScope, profileRows.map(p => p.subjectId), { status: "active" });
    const profiles = profileRows.map(p => ({
      name: p.displayName,
      summary: p.summary,
      traits: p.facets.traits,
      attributes: (attrMap.get(p.subjectId) ?? []).map(a => ({ field: a.field, value: a.value, confidence: a.confidence })),
    }));
    const pair = await buildPairContext(store, eventStore, dmScope, userId, compSubj);
    const relationships = pair ? [pair] : [];
    const context = (await store.recentContext(dmScope, message.channel.id))
      .map(x => ({
        ...x,
        content: demangleMentions(x.content, lookups.names),
        replyToSnippet: x.replyToSnippet ? demangleMentions(x.replyToSnippet, lookups.names) : undefined,
      }));
    const freshOwnerName = await store.displayNameFor(dmScope, userId);
    const serverDigest = await gatherServerDigestForDm(
      store,
      eventStore,
      userId,
      companion,
      gId => client.guilds.cache.get(gId)?.name,
    );
    // One embed call feeds both semantic legs — the query text is the same.
    const queryVec = await defaultEmbedder().embed(`${event.content} ${replyToContent ?? ""}`).catch(() => null);
    const journal = await promptJournal(companion.id, dmScope, [userId], queryVec);
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
    };

    // visionClient is always operator-key spend (BYOK users' images run on it
    // too) — so it counts against the hosted:global breaker, not just the
    // scope cap.
    const meteredVision = visionClient
      ? meteredClient(meteredClient(visionClient, { guildId: dmScope, store, getCap: async () => config.dmLlmDailyCap }), { guildId: "hosted:global", store, getCap: async () => config.hostedDailyLlmCap })
      : undefined;
    // Vision descriptions cache on the archive row — whichever pass (extract
    // job or reply) describes the attachments first is reused by every other.
    let imageContext = images.length && config.visionModel
      ? (await store.getMessage(dmScope, event.messageId))?.imageContext ?? undefined
      : undefined;
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
      if (imageContext) await store.setImageContext(dmScope, event.messageId, imageContext).catch(() => {});
    }

    const toolCtx: ToolCtx = {
      guildId: dmScope, store, eventStore, profileStore,
      resolveName: n => lookups.map.get(n.trim().toLowerCase()),
    };
    // Tools (compound web_search etc.) are premium-only on the hosted lane —
    // per-call tool billing can run ~5x a plain reply. BYOK lanes keep tools.
    const toolsWanted = config.replyTools && toolCues(event.content);
    const toolsOn = toolsWanted && (!hostedDm || account?.plan === "premium");
    const { text } = await brain.reply(
      { ...event, authorName: freshOwnerName },
      context,
      await promptMemories(dmScope, userId, `${event.content} ${replyToContent ?? ""}`, queryVec),
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
      inc("reply.schema_leak"); replyThrottle.refund(dmScope, userId);
      if (chargedDm) refundTurn(userId, 1, "dm_turn_refund");
      return;
    }
    // Adopted companions are third-party authored personas riding our
    // pipeline — their replies get a safety screen on BOTH lanes (BYOK and
    // hosted). Fail-open on screen error: a provider hiccup sends the reply
    // and logs the gap; a flag swaps in a neutral refusal and refunds the
    // reply leg — the bad persona is the marketplace's problem, not the
    // adopter's charge.
    let dmReplyText = clean;
    if (dmReplyText && companion.kind === "adopted" && brain) {
      try {
        const verdict = await brain.safetyVerdict({
          kind: "reply",
          subject: `${companion.name} — ${companion.voicePersona}${companion.backstory ? ` (${companion.backstory.slice(0, 300)})` : ""}`,
          replyText: dmReplyText,
        });
        if (verdict.verdict === "flag") {
          inc("safety.reply_flagged");
          dmReplyText = SAFE_REFUSAL;
          if (chargedDm) { refundTurn(userId, 1, "dm_turn_refund"); chargedDm -= 1; }
        }
      } catch (error) {
        inc("safety.screen_error");
        logError("adopted reply safety screen failed", error);
      }
    }
    if (dmReplyText) {
      const sent = await message.reply({ content: dmReplyText, allowedMentions: { parse: [], repliedUser: false } });
      dmReplied = true;
      inc("reply.sent");
      await store.recordMessage({
        guildId: dmScope,
        channelId: message.channel.id,
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
      const journalDelay = account?.plan === "free" && hostedDm ? nextHourBoundary() : undefined;
      enqueue(sql, dmScope, "journal-write", {
        companionId: companion.id, triggerMessageId: event.messageId,
        replyMessageId: sent.id, channelId: message.channel.id,
      }, journalDelay).catch(() => inc("jobs.enqueue_error"));
      if (chargedDm) void maybeAlertLowCredit(userId, dmBalance);
      // Free+hosted users never see tools — a once-a-day hint that Premium
      // unlocks them is the only way they'd learn the feature exists.
      if (toolsWanted && !toolsOn && account && account.plan !== "premium" && toolsNudgeDue(userId)) {
        inc("premium.tools_nudge");
        message.channel.send(`${companion.name} almost went looking that up — Premium unlocks web search and link-reading: ${config.siteUrl}/dashboard#billing`).catch(() => {});
      }
    } else {
      inc("reply.empty");
      replyThrottle.refund(dmScope, userId);
      if (chargedDm) refundTurn(userId, 1, "dm_turn_refund");
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      inc("budget.reply_blocked");
      replyThrottle.refund(dmScope, userId);
      // Only refund the reply-leg if no reply actually landed — a bookkeeping
      // throw after send shouldn't claw back a delivered turn.
      if (chargedDm && !dmReplied) refundTurn(userId, 1, "dm_turn_refund");
      if (budgetNoticeOnce(message.channel.id)) {
        const hostedOut = error.guildId === "hosted:global";
        await message.reply({ content: hostedOut ? HOSTED_CAPACITY : "We've hit today's DM message limit — it resets at midnight UTC.", allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
      }
      return;
    }
    inc("llm.reply_error");
    logError("DM reply generation failed", error);
    replyThrottle.refund(dmScope, userId);
    if (chargedDm && !dmReplied) refundTurn(userId, 1, "dm_turn_refund");
  }
}

async function handleMessage(message: OmitPartialGroupDMChannel<Message>) {
  // Image attachments are gated before the empty-content early-out so an
  // image-only message still reaches extraction; VISION_MODEL unset = off.
  const images = config.visionModel
    ? qualifyingImages(message.attachments.values(), config.imageMaxBytes, IMAGE_MAX_PER_MESSAGE)
    : [];
  if (!message.guild) {
    await handleDmMessage(message, images);
    return;
  }
  if (!message.content.trim() && !images.length) return;
  if (config.guildId && message.guild.id !== config.guildId) return;
  // Support tickets are private threads in the house — staff-supervised
  // conversations that must never hit automod (a user pasting a phishing
  // link shouldn't watch their own ticket get deleted) or the memory
  // pipeline (privacy). Scoped to the house: private threads elsewhere can
  // still host summoned companions.
  if (isHouse(message.guild.id) && message.channel.type === ChannelType.PrivateThread) return;
  // House automod runs before archive/LLM work — a deleted scam never enters
  // the memory pipeline or spends a credit. Bots/webhook-echoes are skipped
  // inside (companion sends arrive as webhook-authored messages).
  if (isHouse(message.guild.id) && !message.author.bot) {
    const acted = await automodMessage(message, opsDeps)
      .catch(e => { inc("ops.automod_error"); logError("automod failed", e); return false; });
    if (acted) return;
  }
  // Marketplace listing threads are a comment surface, not memory material —
  // no archive, extraction, awaken-notice, or companion replies. Automod has
  // already run above, so moderation coverage is unchanged.
  if (isMarketplaceThread(message.channel)) return;

  // Check whether this guild message was sent by one of our own companion
  // webhooks. Discord can dispatch the MessageCreate echo before the send
  // path's recordWebhookMessage commits, so a webhook-authored message that
  // misses the first lookup gets a short grace window — otherwise it's
  // archived under the webhook's bot id and the send path's recordMessage
  // (ON CONFLICT DO NOTHING) can never correct the attribution.
  let inboundWebhook: Awaited<ReturnType<typeof store.getWebhookMessage>> = null;
  if (message.author.bot) {
    // message.webhookId is only set on webhook echoes; a real bot user gets
    // one lookup, a webhook gets three tries over ~500ms to outrun the race.
    const tries = message.webhookId ? 3 : 1;
    for (let i = 0; i < tries; i++) {
      inboundWebhook = await store.getWebhookMessage(message.id);
      if (inboundWebhook) break;
      if (i + 1 < tries) await sleep(250);
    }
  }
  const senderCompanion = inboundWebhook ? await store.getCompanionById(inboundWebhook.companionId) : null;

  const event: MessageEvent = {
    guildId: message.guild.id, channelId: message.channel.id, messageId: message.id,
    authorId: senderCompanion ? MemoryStore.companionSubjectId(senderCompanion.id) : message.author.id,
    authorName: senderCompanion ? senderCompanion.name : (message.member?.displayName ?? message.author.username),
    content: message.content, createdAt: message.createdAt,
    // Direct @-mention or reply to the Characterly system bot (only triggers a
    // system status card — Characterly itself never speaks as a character).
    mentionsBot: message.mentions.has(client.user!) || message.mentions.repliedUser?.id === client.user!.id,
    imageAttachments: images.length ? images : undefined,
  };
  const settings = await store.settings(event.guildId, config.rawMessageRetentionDays);
  // "Pause observing" must actually stop observing — a paused guild gets no
  // raw archive rows or member-registry writes, not just no extraction. The
  // sweep skips paused guilds anyway, so archive-during-pause rows would be
  // orphaned the moment they're written.
  if (!settings.memoryEnabled && !settings.replyEnabled) return;
  // Threads inherit their parent channel's listing, so check both — a thread
  // inside an ignored/quiet channel follows the parent (and can be listed on
  // its own). isThread() (not parentId) keeps categories out of the match — a
  // text channel's parentId is its category, and a category id in the list
  // must not darken everything under it.
  const parentChannelId = (message.channel as { isThread?: () => boolean; parentId?: string | null }).isThread?.()
    ? (message.channel as { parentId?: string | null }).parentId
    : null;
  // Ignored channels are truly invisible: no archive, no replies, no member
  // writes — checked before brainFor/recordMessage so nothing at all happens.
  if (settings.ignoredChannels.includes(event.channelId) || (parentChannelId != null && settings.ignoredChannels.includes(parentChannelId))) return;
  // Quiet channels suppress only companion speech (and companion system
  // cards) — archiving and extraction below keep running.
  const quiet = settings.quietChannels.includes(event.channelId) || (parentChannelId != null && settings.quietChannels.includes(parentChannelId));
  // Pure companion mode: only user-summoned companions speak in guild channels.
  const guildCompanions = await store.listGuildCompanions(event.guildId);
  if (!senderCompanion && settings.replyEnabled && !quiet && event.mentionsBot && noCompanionNoticeOnce(event.channelId)) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("onboard:start")
        .setLabel("Awaken / Summon Companion")
        .setStyle(ButtonStyle.Primary),
    );
    const activeList = guildCompanions.length
      ? `Active companions here: ${guildCompanions.map(c => `**${c.name}**`).join(", ")}. Say a companion's name in chat (or reply to their message) to talk to them!`
      : "No companions have been summoned to this server yet! Click below (or send me a DM) to awaken your personal companion, then summon them here with `/companion action:summon`.";
    await message.reply({
      content: `*System — Characterly Host:* ${activeList}`,
      components: [row],
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => {});
  }

  // Resolve the reply target first so it can be persisted with the raw message.
  const replyToId = message.reference?.messageId ?? undefined;
  // Companion webhook messages are already archived at send time; other bots
  // are archived as noise and never trigger replies.
  if (message.author.bot && !senderCompanion) {
    if (settings.memoryEnabled) {
      await store.recordMessage(event, replyToId, false, true);
      await store.setTriageResults([{ id: event.messageId, result: "noise" }]);
    }
    return;
  }
  if (!senderCompanion && settings.memoryEnabled) {
    await store.recordMessage(event, replyToId, true, false);
  }
  let replyToContent: string | undefined;
  let replyToAuthorId: string | undefined;
  const repliedToWebhook = replyToId ? await store.getWebhookMessage(replyToId) : null;
  if (replyToId) {
    const ref = await store.getMessage(event.guildId, replyToId);
    if (ref) { replyToContent = `${ref.authorName}: ${ref.content}`; replyToAuthorId = ref.authorId; }
    else {
      // Reply target isn't archived (bot message that predates this, pre-boot
      // history) — ask Discord for it so the reference still resolves.
      const live = await message.channel.messages.fetch(replyToId).catch(() => undefined);
      if (live) { replyToContent = `${live.member?.displayName ?? live.author.username}: ${live.content}`; replyToAuthorId = live.author.id; }
    }
  }
  // Per-image describe, per-image fault tolerance — a dead URL or a 429 skips
  // that image, never the message's text. Memoized so extraction and the reply
  // path share one describe pass for the same message. A separate vision
  // client is operator spend but still counts against this guild's daily cap —
  // metered here (undefined → describeImage uses the brain's metered client).
  const meteredVision = visionClient
    ? meteredClient(meteredClient(visionClient, { guildId: event.guildId, store, getCap: async () => (await store.settings(event.guildId, config.rawMessageRetentionDays)).llmDailyCap }), { guildId: "hosted:global", store, getCap: async () => config.hostedDailyLlmCap })
    : undefined;
  const describeImages = (list: Array<AttachmentMeta & { contentType: string }>, activeBrain: Brain) =>
    Promise.all(list.map(async a => {
      try {
        const d = await activeBrain.describeImage({ url: a.url, contextText: event.content, maxBytes: config.imageMaxBytes }, config.visionModel!, meteredVision);
        inc("vision.described");
        return d.description;
      } catch (error) {
        if (error instanceof BudgetExceeded) throw error; // lands in the reply block's budget notice
        inc("vision.error"); logError("Image describe failed", error); return undefined;
      }
    })).then(list => list.filter((d): d is string => !!d));
  // Vision output caches on the archive row (messages.image_context) — the
  // extract job and every later reply reuse the first describe pass instead of
  // re-billing for the same attachments.
  const imageContextFor = async (list: Array<AttachmentMeta & { contentType: string }>, authorName: string, activeBrain: Brain, sourceMessageId?: string): Promise<string> => {
    if (!list.length) return "";
    const cached = sourceMessageId
      ? (await store.getMessage(event.guildId, sourceMessageId))?.imageContext
      : undefined;
    if (cached) return cached;
    const descs = await describeImages(list, activeBrain);
    if (!descs.length) return "";
    const formatted = formatImageContext(descs, authorName);
    if (sourceMessageId && formatted) await store.setImageContext(event.guildId, sourceMessageId, formatted).catch(() => {});
    return formatted;
  };
  // Resolve the scope brain BEFORE the throttle check — hostedScopes only
  // populates on resolution, so checking isHostedScope before brainFor would
  // read a cold cache as non-hosted and skip the free-tier throttle.
  const brain = await brainFor(event.guildId);
  // Extraction, contest detection, and the event pipeline all defer to the
  // 'extract' job — the live path keeps only recordMessage/decide/reply so a
  // busy guild can't stack unbounded concurrent LLM calls inside one handler.
  if (!senderCompanion && settings.memoryEnabled && (shouldInspectForMemory(event) || images.length)) {
    try {
      // Free-tier memory settles in hourly batches on the hosted lane;
      // premium and BYOK-backed scopes extract live. Unlinked speakers
      // count as free.
      const extractAcct = isHostedScope(event.guildId)
        ? await store.accountForDiscordUser(event.authorId).catch(() => null)
        : null;
      const throttleMemory = isHostedScope(event.guildId) && (!extractAcct || extractAcct.plan === "free");
      await enqueue(sql, event.guildId, "extract", { event, replyToId, replyToContent }, throttleMemory ? nextHourBoundary() : undefined);
      await store.setTriageResults([{ id: event.messageId, result: "queued" }]);
      inc("jobs.enqueued");
    } catch (error) { inc("jobs.enqueue_error"); logError("Extraction enqueue failed", error); }
  }

  // Replies need summoned companions AND a resolvable brain — but archiving
  // and extraction above do not, so an enabled guild with zero companions
  // still builds memory (and /privacy's "Observing" status stays honest).
  // Quiet channels end here too: memory continues, companions don't speak.
  if (!settings.replyEnabled || quiet || !guildCompanions.length || !brain) return;

  const selection = selectCompanionForTurn(
    {
      event,
      companions: guildCompanions,
      repliedToCompanionId: repliedToWebhook?.companionId,
      repliedToHumanUserId:
        replyToAuthorId && !replyToAuthorId.startsWith("companion:") && replyToAuthorId !== client.user!.id
          ? replyToAuthorId
          : undefined,
      mentionedUserIds: [...message.mentions.users.keys()].filter(id => id !== client.user!.id),
      senderCompanionId: senderCompanion?.id,
      chainDepth: inboundWebhook?.chainDepth ?? 0,
    },
    convo,
    {
      speakThreshold: config.speakThreshold,
      maxChainDepth: config.maxCompanionChainDepth,
      engagement: config.engagement,
      wakeWord: config.wakeWord,
    },
  );

  if (!selection) {
    return;
  }

  const chosen = selection.companion;
  const compSubj = MemoryStore.companionSubjectId(chosen.id);
  const engaged = selection.engaged;
  // Companion↔companion turns bill the replying companion's owner — the c2c
  // settings toggle is their spend-control, checked before anything burns.
  if (senderCompanion) {
    const s = await store.userBotSettings(chosen.ownerUserId).catch(() => null);
    if (s && !s.c2cEnabled) return;
  }
  const ownerBrain = await brainForUser(chosen.ownerUserId, event.guildId);
  const companionBrain = ownerBrain ?? brain;
  // Hosted iff the brain actually serving this turn rides the env key — owner
  // and guild BYOK lanes never spend tokens.
  const hostedGuild = ownerBrain
    ? isHostedUserBrain(chosen.ownerUserId, event.guildId)
    : isHostedScope(event.guildId);
  // Payer: a human covers their whole turn (2: their message + the reply); a
  // replying companion's turn in a c2c chain bills its owner (1 — the inbound
  // companion message was paid for when it was generated).
  const payerId = senderCompanion ? chosen.ownerUserId : event.authorId;
  // Unlinked human speakers get a once-per-cooldown pointer (in-channel —
  // ephemeral isn't possible for plain messages). Unlinked c2c owners just
  // hear silence; their DM gate already pointed them at /link.
  if (hostedGuild && !senderCompanion && !(await store.accountForDiscordUser(payerId))) {
    if (linkPromptDue(`${event.guildId}:${payerId}`)) {
      await message.reply({ content: LINK_PROMPT, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
      inc("gate.unlinked_guild");
    }
    return;
  }
  const throttleActor = senderCompanion ? compSubj : event.authorId;
  if (!replyThrottle.consume(event.guildId, throttleActor)) { inc("reply.cooldown"); return; }
  let chargedGuild = 0;
  let guildBalance = 0;
  let guildReplied = false;
  let payerPremium = false;
  if (hostedGuild) {
    // Resolve the payer's plan once — drives the pressure shed below and the
    // tools gate on the reply. Cached-hit for humans (gate looked them up).
    const payerAccount = await store.accountForDiscordUser(payerId).catch(() => null);
    if (!payerAccount) {
      replyThrottle.refund(event.guildId, throttleActor);
      if (!senderCompanion && linkPromptDue(`${event.guildId}:${payerId}`)) {
        await message.reply({ content: LINK_PROMPT, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
        inc("gate.unlinked_guild");
      }
      return;
    }
    payerPremium = payerAccount.plan === "premium";
    // Free lane sheds first when the fleet breaker is nearly tripped.
    if (!payerPremium && (await store.hostedUsageToday()) >= config.hostedDailyLlmCap * 0.9) {
      inc("gate.hosted_pressure");
      replyThrottle.refund(event.guildId, throttleActor);
      if (!senderCompanion && budgetNoticeOnce(event.channelId)) {
        await message.reply({ content: HOSTED_CAPACITY, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
      }
      return;
    }
    const cost = senderCompanion ? 1 : 2;
    const spend = await store.spendCredits(payerId, cost, senderCompanion ? "c2c" : "guild_turn");
    if (!spend.ok) {
      inc("credits.insufficient");
      replyThrottle.refund(event.guildId, throttleActor);
      // A cached account can outlive a dashboard unlink — re-check which
      // notice fits (c2c owners get silence either way).
      if (!senderCompanion && budgetNoticeOnce(event.channelId)) {
        const stillLinked = await store.accountForDiscordUser(payerId).catch(() => null);
        await message.reply({ content: stillLinked ? TOKEN_EMPTY : LINK_PROMPT, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
      }
      return;
    }
    chargedGuild = cost;
    guildBalance = spend.balance;
  }

  try {
    await message.channel.sendTyping();
    const lookups = await guildLookups(event.guildId);
    const peopleIds = new Set<string>([
      event.authorId,
      chosen.ownerUserId,
      compSubj,
      ...message.mentions.users.keys(),
      ...findMentionedUsers(event.content, lookups.map).slice(0, 3),
    ]);
    const profileRows = await profileStore.getProfiles(event.guildId, [...peopleIds]);
    const attrMap = await store.attributesForSubjects(event.guildId, profileRows.map(p => p.subjectId), { status: "active" });
    const profiles = profileRows.map(p => ({
      name: p.displayName, summary: p.summary, traits: p.facets.traits,
      attributes: (attrMap.get(p.subjectId) ?? []).map(a => ({ field: a.field, value: a.value, confidence: a.confidence })),
    }));

    const pairIds = [...peopleIds].filter(id => id !== client.user!.id);
    const pairList: Array<[string, string]> = [];
    for (let i = 0; i < pairIds.length; i++)
      for (let j = i + 1; j < pairIds.length; j++) pairList.push([pairIds[i], pairIds[j]]);
    pairList.sort((x, y) =>
      Number(y.includes(compSubj) || y.includes(event.authorId)) -
      Number(x.includes(compSubj) || x.includes(event.authorId)),
    );
    const relationships = (await Promise.all(pairList.slice(0, 6).map(([aId, bId]) =>
      buildPairContext(store, eventStore, event.guildId, aId, bId)
    ))).filter((x): x is PairContext => !!x);

    const context = (await store.recentContext(event.guildId, event.channelId))
      .map(x => ({ ...x, content: demangleMentions(x.content, lookups.names), replyToSnippet: x.replyToSnippet ? demangleMentions(x.replyToSnippet, lookups.names) : undefined }));
    const authorName = senderCompanion
      ? senderCompanion.name
      : await store.displayNameFor(event.guildId, event.authorId);
    const ownerName = message.guild.ownerId ? await store.displayNameFor(event.guildId, message.guild.ownerId) : undefined;
    const companionOwnerName = await store.displayNameFor(event.guildId, chosen.ownerUserId);
    const ownerSubtext = await gatherOwnerSubtextForServer(store, chosen.ownerUserId, chosen.id);
    // Origin-scoped journal: only entries formed in THIS guild — a dismissed
    // companion's dormant entries never surface elsewhere.
    const queryVec = await defaultEmbedder().embed(`${event.content} ${replyToContent ?? ""}`).catch(() => null);
    const journal = await promptJournal(chosen.id, event.guildId, [event.authorId, chosen.ownerUserId], queryVec);

    const persona: CompanionPersona = {
      companionId: chosen.id,
      name: chosen.name,
      ownerUserId: chosen.ownerUserId,
      ownerName: companionOwnerName,
      voicePersona: chosen.voicePersona,
      coreTraits: chosen.coreTraits,
      ownerDynamic: chosen.ownerDynamic,
      backstory: chosen.backstory,
      ownerSubtext,
      journal,
    };

    const imgParts: string[] = [];
    if (images.length) imgParts.push(await imageContextFor(images, authorName, companionBrain, event.messageId));
    if (replyToId) {
      const refMsg = await message.channel.messages.fetch(replyToId).catch(() => undefined);
      const refImages = refMsg ? qualifyingImages(refMsg.attachments.values(), config.imageMaxBytes, IMAGE_MAX_PER_MESSAGE) : [];
      if (refImages.length && refMsg)
        imgParts.push(await imageContextFor(refImages, refMsg.member?.displayName ?? refMsg.author.username, companionBrain, replyToId));
    }
    const imageContext = imgParts.filter(Boolean).join("\n") || undefined;

    const toolCtx: ToolCtx = {
      guildId: event.guildId, store, eventStore, profileStore,
      resolveName: n => lookups.map.get(n.trim().toLowerCase()),
    };
    // Same premium gate as DMs — hosted free lanes get plain replies.
    const toolsOn = config.replyTools && (toolCues(event.content) || selection.isAddressed || engaged) && (!hostedGuild || payerPremium);
    const { text, endConversation } = await companionBrain.reply(
      { ...event, authorName },
      context,
      await promptMemories(event.guildId, event.authorId, `${event.content} ${replyToContent ?? ""}`, queryVec),
      profiles,
      relationships,
      config.replyModel,
      toolsOn,
      compSubj,
      { guildName: message.guild.name, ownerName, botName: chosen.name, companion: persona },
      toolCtx,
      imageContext,
    );
    const clean = text ? scrubMentions(text, lookups.names) : "";
    // Send-boundary guards: model internals must never reach a channel, and a
    // verbatim echo of the owner's private DM subtext means the vault rule
    // failed — suppress the send rather than disclose across contexts.
    const leak = clean && looksLikeSchemaLeak(clean) ? "reply.schema_leak"
      : clean && containsPrivateSubtext(clean, ownerSubtext) ? "reply.vault_leak" : null;
    if (leak) {
      inc(leak); replyThrottle.refund(event.guildId, throttleActor);
      if (chargedGuild) refundTurn(payerId, 1, "guild_turn_refund");
      return;
    }
    // Same adopted-companion safety screen as the DM path — flag swaps in a
    // neutral refusal (channel isn't ghosted) + refunds the reply leg; a
    // screen error fails open with a metric, not a dead turn.
    let guildReplyText = clean;
    if (guildReplyText && chosen.kind === "adopted" && companionBrain) {
      try {
        const verdict = await companionBrain.safetyVerdict({
          kind: "reply",
          subject: `${chosen.name} — ${chosen.voicePersona}${chosen.backstory ? ` (${chosen.backstory.slice(0, 300)})` : ""}`,
          replyText: guildReplyText,
        });
        if (verdict.verdict === "flag") {
          inc("safety.reply_flagged");
          guildReplyText = SAFE_REFUSAL;
          if (chargedGuild) { refundTurn(payerId, 1, "guild_turn_refund"); chargedGuild -= 1; }
        }
      } catch (error) {
        inc("safety.screen_error");
        logError("guild adopted reply safety screen failed", error);
      }
    }
    if (guildReplyText) {
      const sent = await sendAsCompanion(message, chosen, guildReplyText, client.user!.id);
      if (!sent) {
        replyThrottle.refund(event.guildId, throttleActor);
        if (chargedGuild) refundTurn(payerId, 1, "guild_turn_refund");
        return;
      }
      guildReplied = true;
      convo.noteReply(selection.convoKey);
      convo.noteReply(selection.floorKey);
      inc("reply.sent");
      if (engaged && !selection.isAddressed) inc("reply.engaged");
      await store.recordWebhookMessage(sent.id, event.guildId, event.channelId, chosen.id, selection.nextChainDepth);
      await store.recordMessage({
        guildId: event.guildId, channelId: event.channelId, messageId: sent.id,
        authorId: compSubj, authorName: chosen.name,
        content: guildReplyText, createdAt: sent.createdAt, mentionsBot: false,
      }, event.messageId, false, true);
      await store.setTriageResults([{ id: sent.id, result: "noise" }]);
      // Same deferred journaling as the DM path — hourly cadence for
      // free+hosted owners, live for premium/BYOK.
      const ownerAccount = chargedGuild ? await store.accountForDiscordUser(chosen.ownerUserId).catch(() => null) : null;
      const journalDelay = ownerAccount?.plan === "free" ? nextHourBoundary() : undefined;
      enqueue(sql, event.guildId, "journal-write", {
        companionId: chosen.id, triggerMessageId: event.messageId,
        replyMessageId: sent.id, channelId: event.channelId,
      }, journalDelay).catch(() => inc("jobs.enqueue_error"));
      // c2c hops spend the owner's tokens too — the alert is their spend
      // control, not just the human-payer path's.
      if (chargedGuild) void maybeAlertLowCredit(payerId, guildBalance);
    } else {
      inc("reply.empty"); replyThrottle.refund(event.guildId, throttleActor);
      if (chargedGuild) refundTurn(payerId, 1, "guild_turn_refund");
    }
    if (config.replyExit && endConversation && convo.leave(selection.convoKey, event.authorId)) {
      inc("convo.leave.model");
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      inc("budget.reply_blocked");
      replyThrottle.refund(event.guildId, throttleActor);
      // Only refund the reply-leg when no reply landed — a bookkeeping throw
      // after send shouldn't claw back a delivered turn.
      if (chargedGuild && !guildReplied) refundTurn(payerId, 1, "guild_turn_refund");
      if (budgetNoticeOnce(event.channelId)) {
        const hostedOut = error.guildId === "hosted:global";
        await message.reply({ content: hostedOut ? HOSTED_CAPACITY : "I've hit this server's daily LLM limit, so I can't respond right now — it resets at midnight UTC. An admin can raise it with `/limits`.", allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
      }
      return;
    }
    inc("llm.reply_error"); logError("Reply generation failed", error);
    replyThrottle.refund(event.guildId, throttleActor);
    if (chargedGuild && !guildReplied) refundTurn(payerId, 1, "guild_turn_refund");
  }
}

// Graceful shutdown — close the Discord socket and the pg pool cleanly so
// container/systemd restarts don't sever in-flight work.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`Received ${sig}, shutting down`);
    await worker?.stop(); // finish in-flight jobs, claim nothing new
    client.destroy();
    await sql.end();
    process.exit(0);
  });
}

client.login(config.discordToken);
