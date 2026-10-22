import "dotenv/config";
import { z } from "zod";

const env = z.object({
  // Required at runtime by the bot; tests don't need these — use empty string default.
  DISCORD_TOKEN: z.string().default(""),
  GROQ_API_KEY: z.string().default(""),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  // Optional when running tests via TEST_DATABASE_URL — db.ts prefers TEST_DATABASE_URL.
  DATABASE_URL: z.string().default(""),
  GUILD_ID: z.string().optional(),
  SPEAK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  RAW_MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  CANDIDATE_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  // Model overrides — all optional; per-feature fallback chains live in the
  // derived config below so a typo'd name or value is visible in one place.
  VERIFY_MODEL: z.string().optional(),
  PROFILE_MODEL: z.string().optional(),
  DOSSIER_MODEL: z.string().optional(),
  CONTEST_MODEL: z.string().optional(),
  INGEST_MODEL: z.string().optional(),
  INGEST_TRIAGE_MODEL: z.string().optional(),
  REPLY_MODEL: z.string().optional(),
  REPLY_TOOLS: z.string().optional(),
  REPLY_EXIT: z.string().optional(),
  // Semantic recall embeddings — any OpenAI-compatible /embeddings endpoint
  // (local Ollama, OpenAI, vLLM, LM Studio). Unset URL = feature OFF; the
  // lexical recall legs keep working untouched.
  EMBED_BASE_URL: z.string().optional(),
  EMBED_MODEL: z.string().default("all-minilm"),
  EMBED_API_KEY: z.string().default("ollama"),
  EMBED_DIMS: z.coerce.number().int().min(8).max(8192).default(384),
  // Cosine-distance ceiling for semantic hits — below this, a "match" isn't
  // about the same thing and would only dilute the prompt.
  EMBED_MAX_DISTANCE: z.coerce.number().min(0).max(2).default(0.55),
  // Per-user reply budget: a troll spamming mentions or rapid follow-ups
  // drains the guild's daily LLM cap for everyone else. Burst allows natural
  // ping-pong, refill bounds the sustained drain (~1/refill per user).
  REPLY_BURST: z.coerce.number().int().min(1).max(50).default(4),
  REPLY_REFILL_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
  // Daily "Regenerate" (right-click reply retry) cap — free+hosted lane only;
  // premium and BYOK lanes are bounded by their own spend.
  REGEN_DAILY_CAP: z.coerce.number().int().min(0).default(20),
  VISION_MODEL: z.string().optional(),
  VISION_API_KEY: z.string().optional(),
  WAKE_WORD: z.string().optional(),
  ENGAGEMENT: z.string().optional(),
  ENGAGEMENT_TTL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(120_000),
  VISION_BASE_URL: z.string().optional(),
  IMAGE_MAX_BYTES: z.coerce.number().int().min(1).default(4_000_000),
  // BYOK: master passphrase for encrypting per-guild LLM keys at rest. Optional —
  // self-hosters without /setup never need it; /setup errors helpfully without it.
  KEY_ENCRYPTION_SECRET: z.string().optional(),
  // Hosted mode: 1 disables the env-key fallback so keyless guilds stay dormant.
  REQUIRE_GUILD_KEYS: z.string().optional(),
  // Per-user daily LLM call cap for 1:1 DMs (dm:<userId> scope, always uses operator envKey).
  DM_LLM_DAILY_CAP: z.coerce.number().int().min(0).max(100_000).default(250),
  // Live transcript window for DM replies — wider than the shared-guild
  // default (25) because a 1:1 chat has no other voices; the story recap
  // still covers everything older than STORY_KEEP_RECENT.
  DM_CONTEXT_MESSAGES: z.coerce.number().int().min(10).max(100).default(40),
  // Maximum consecutive companion-to-companion replies per human message in a server channel.
  MAX_COMPANION_CHAIN_DEPTH: z.coerce.number().int().min(0).max(5).default(2),
  // Where the public website lives — /link replies point users here to claim
  // their code. Override for self-hosted/front-end forks.
  SITE_URL: z.string().default("https://characterly.app"),
  // Durable avatar lane: the website worker's PUT /avatar proxies uploads into
  // a public Supabase Storage bucket behind this shared secret. Unset = lane
  // off — every avatar_url set-point keeps the source URL (today's behavior).
  AVATAR_UPLOAD_SECRET: z.string().optional(),
  // ── Hosted-model credits (user-facing name: "tokens") ───────────────────────
  // Lazy refill: grants apply inside the spend tx when the marker date rolls.
  // Premium is a single 150/day floor — "practically unlimited" for humans but
  // still metered so an abusive account is bounded (≈$4.50/mo worst case).
  FREE_DAILY_CREDITS: z.coerce.number().int().min(0).default(30),
  PREMIUM_DAILY_CREDITS: z.coerce.number().int().min(0).default(150),
  // Circuit breaker: total hosted-lane LLM calls per UTC day, fleet-wide —
  // bounds operator spend independent of per-user credits.
  HOSTED_DAILY_LLM_CAP: z.coerce.number().int().min(0).default(20_000),
  // Share of HOSTED_DAILY_LLM_CAP that background cognition (memory
  // extraction, journals, recaps, triage, nightly maintenance) may use — the
  // rest is reserved so live chat never sheds because jobs ate the budget.
  HOSTED_BACKGROUND_SHARE: z.coerce.number().min(0).max(1).default(0.4),
  // Revenue-aware fleet bonus (src/fleet-cap.ts): active premium subs fund
  // extra hosted calls on top of HOSTED_DAILY_LLM_CAP so a converting viral
  // spike grows the free lane instead of shedding it. Usage alone never
  // raises the cap. Blended daily revenue per sub defaults to the yearly
  // rate ($79.99/365 ≈ $0.22) — web_profiles has no plan interval, so the
  // conservative end is the honest default.
  FLEET_PREMIUM_DAILY_REVENUE_USD: z.coerce.number().min(0).default(0.22),
  // Operator estimate of blended cost per hosted LLM call — bias high and
  // revisit; the safety factor + MAX_BONUS ceiling keep a bad guess bounded.
  FLEET_COST_PER_HOSTED_CALL_USD: z.coerce.number().min(0).default(0.0005),
  FLEET_CAP_SAFETY_FACTOR: z.coerce.number().min(0).max(1).default(0.5),
  // Absolute ceiling on the bonus — effective cap can never exceed
  // HOSTED_DAILY_LLM_CAP + this, whatever the formula says.
  FLEET_CAP_MAX_BONUS: z.coerce.number().int().min(0).default(60_000),
  // DM the user when a post-spend balance drops to this or below (once/day).
  LOW_CREDIT_ALERT: z.coerce.number().int().min(0).default(5),
  // Hosted onboarding turns that are free before each further draft turn
  // costs a normal 2-token turn — the interview is otherwise unlimited free
  // chat on the reply model. BYOK onboarding never pays.
  ONBOARDING_FREE_TURNS: z.coerce.number().int().min(0).default(8),
  // Cooldown between "link your account" prompts per unlinked user.
  LINK_PROMPT_COOLDOWN_MS: z.coerce.number().int().min(60_000).default(14_400_000),
  // Companion marketplace (hub forum): publish target + report ping channel.
  MARKETPLACE_CHANNEL_ID: z.string().optional(),
  MARKETPLACE_MOD_CHANNEL_ID: z.string().optional(),
  // Per-listing re-adopt cooldown after a drop (default 12h), free-tier active
  // adoption cap (premium is uncapped), and reports needed to auto-flag.
  ADOPTION_COOLDOWN_MS: z.coerce.number().int().min(3_600_000).default(43_200_000),
  FREE_ADOPTION_SLOTS: z.coerce.number().int().min(0).default(1),
  FREE_LISTING_SLOTS: z.coerce.number().int().min(0).default(2),
  MARKETPLACE_REPORT_FLAG_THRESHOLD: z.coerce.number().int().min(1).default(3),
  // Moderation: mod action buttons are gated to these role ids (comma list);
  // when unset, ManageGuild members can act. Daily caps are per UTC day.
  MARKETPLACE_MOD_ROLE_IDS: z.string().optional(),
  MARKET_PUBLISH_DAILY_CAP: z.coerce.number().int().min(1).default(5),
  MARKET_REPORT_DAILY_CAP: z.coerce.number().int().min(1).default(20),
  MARKET_ADOPT_DAILY_CAP: z.coerce.number().int().min(1).default(20),
  HOUSE_THREAD_WARN: z.coerce.number().int().min(1).default(700),
  HOUSE_THREAD_CLEAR: z.coerce.number().int().min(1).default(600),
  // The ~1,000 active-thread ceiling is guild-WIDE — tickets and forum posts
  // count too — so the floodgate also watches the house's total, not just
  // #adoptees children. Warn/clear sit under the ceiling with margin.
  HOUSE_GUILD_THREAD_WARN: z.coerce.number().int().min(1).default(850),
  HOUSE_GUILD_THREAD_CLEAR: z.coerce.number().int().min(1).default(750),
  // Adoptee-thread inactivity archive — Discord accepts only 60/1440/4320/
  // 10080 minutes. 3d recycles the guild's active-thread slots ~2× faster
  // than the 7d max; an archived thread unarchives when the adopter posts,
  // so the only cost is sidebar visibility for lapsed users.
  ADOPTEE_THREAD_ARCHIVE_MINUTES: z.coerce.number().pipe(
    z.union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)]),
  ).default(4320),
  // Curated forum tags — the bot-managed badges on listing threads. Names are
  // fixed constants in ops.ts; these are the thresholds that earn them.
  MARKET_NEW_TAG_DAYS: z.coerce.number().int().min(1).default(7),
  MARKET_TOP_RATING_AVG: z.coerce.number().min(1).max(5).default(4.5),
  MARKET_TOP_RATING_MIN: z.coerce.number().int().min(1).default(5),
  MARKET_TRENDING_COUNT: z.coerce.number().int().min(1).default(5),
  MARKET_TRENDING_WINDOW_H: z.coerce.number().int().min(1).default(72),
  // Multi-server marketplace: master switch for partner deployments
  // (guild_deployments rows, mirrored listing posts, partner adoptee
  // threads). Off = the marketplace stays house-only even if DB rows exist.
  MARKET_DEPLOY_ENABLED: z.string().optional(),
  // Character-card imports: private unlisted listings a user can hold at once.
  // The adopted clones they spawn still consume normal adoption slots.
  CHARACTER_IMPORT_CAP: z.coerce.number().int().min(1).default(25),
  // Chat-history imports: pending/active distill jobs a user can hold, and the
  // max ~30-turn windows one transcript distills through (bounds hosted spend).
  CHAT_IMPORT_CAP: z.coerce.number().int().min(1).default(3),
  CHAT_IMPORT_MAX_WINDOWS: z.coerce.number().int().min(1).default(50),
  // Safety classifier model — defaults to the hosted reply model; a small
  // fast model is fine (the verdict schema is tiny).
  SAFETY_MODEL: z.string().optional(),
  // ── House ops: the bot privately operates OUR community server + its own
  // host. Entire layer is off unless HOUSE_GUILD_ID is set — never a per-guild
  // feature other servers can reach.
  HOUSE_GUILD_ID: z.string().optional(),
  HOUSE_MEMBER_ROLE_ID: z.string().optional(),
  HOUSE_WELCOME_CHANNEL_ID: z.string().optional(),
  HOUSE_RULES_CHANNEL_ID: z.string().optional(),
  HOUSE_ANNOUNCE_CHANNEL_ID: z.string().optional(),
  // The lobby gate channel: a persistent verify card lives here — clicking it
  // checks for a linked Characterly account and grants HOUSE_MEMBER_ROLE_ID.
  HOUSE_VERIFY_CHANNEL_ID: z.string().optional(),
  // The adoptee-chat surface: adopted companions get named private threads
  // under this channel (v54). Falls back to a name lookup when unset.
  HOUSE_ADOPTEES_CHANNEL_ID: z.string().optional(),
  // Public invite for non-member adopters who need to join the house to meet
  // their companions (falls back to SITE_URL in copy when unset).
  HOUSE_INVITE_URL: z.string().optional(),
  // One-time DM nudge to members who joined >24h ago and never verified.
  // "0" disables; the sweep is capped per run and deduped once-ever.
  HOUSE_VERIFY_NUDGE: z.string().optional(),
  // Where ops alerts/host breaches go — defaults to the marketplace mod channel.
  OPS_CHANNEL_ID: z.string().optional(),
  OPS_ALERT_CHANNEL_ID: z.string().optional(),
  // Discord user ids allowed to run /ops (controls the host — person-level,
  // tighter than ManageGuild).
  OPS_USER_IDS: z.string().optional(),
  // Repo checkout on the host for /ops deploy. `~` is resolved at use.
  OPS_REPO_DIR: z.string().default("~/characterly"),
  // House automod thresholds — all deterministic, house-guild only.
  AUTOMOD_BURST_COUNT: z.coerce.number().int().min(2).default(6),
  AUTOMOD_BURST_WINDOW_MS: z.coerce.number().int().min(1_000).default(8_000),
  AUTOMOD_MENTION_MAX: z.coerce.number().int().min(3).default(8),
  AUTOMOD_NEW_ACCOUNT_DAYS: z.coerce.number().int().min(0).default(7),
  AUTOMOD_RAID_JOINS: z.coerce.number().int().min(3).default(8),
  // "1" auto-kicks new joins while the raid window is hot — default OFF
  // (kicking is one-way; alerts alone usually suffice).
  AUTOMOD_RAID_KICK: z.string().optional(),
  // Repeat-offense count within 24h that escalates to a kick — the
  // mod_actions ledger supplies the count. 0 disables (timeouts cap at 24h).
  AUTOMOD_KICK_THRESHOLD: z.coerce.number().int().min(0).default(4),
  // Host watchdog thresholds (heap %, disk %, event-loop lag ms, tick ms).
  HOST_HEAP_PCT: z.coerce.number().int().min(1).max(100).default(90),
  HOST_DISK_PCT: z.coerce.number().int().min(1).max(100).default(85),
  HOST_LAG_MS: z.coerce.number().int().min(50).default(1_000),
  HOST_HEALTH_INTERVAL_MS: z.coerce.number().int().min(30_000).default(300_000),
}).parse(process.env);

export const config = {
  discordToken: env.DISCORD_TOKEN,
  groqKey: env.GROQ_API_KEY,
  model: env.GROQ_MODEL,
  groqBaseUrl: env.GROQ_BASE_URL,
  databaseUrl: env.DATABASE_URL,
  guildId: env.GUILD_ID,
  speakThreshold: env.SPEAK_THRESHOLD,
  rawMessageRetentionDays: env.RAW_MESSAGE_RETENTION_DAYS,
  candidateConfidenceThreshold: env.CANDIDATE_CONFIDENCE_THRESHOLD,
  // Model override chains — terminal default stays at each call site.
  verifyModel: env.VERIFY_MODEL ?? env.PROFILE_MODEL,
  profileModel: env.PROFILE_MODEL,
  dossierModel: env.DOSSIER_MODEL,
  contestModel: env.CONTEST_MODEL ?? env.VERIFY_MODEL ?? env.INGEST_MODEL,
  ingestModel: env.INGEST_MODEL,
  triageModel: env.INGEST_TRIAGE_MODEL,
  replyModel: env.REPLY_MODEL,
  replyTools: env.REPLY_TOOLS === "1",
  // Kill switch for honoring the model's end_conversation flag — regex
  // dismissal keeps working regardless; this only governs the soft exit.
  replyExit: env.REPLY_EXIT !== "0",
  // No fallback: unset means image understanding is OFF. A text-only model
  // could silently drop the image block and store a hallucinated description.
  visionModel: env.VISION_MODEL,
  // Embedding endpoint for hybrid recall — opt-in; unset disables the
  // semantic legs entirely (writes skip, queries degrade to lexical).
  embedBaseUrl: env.EMBED_BASE_URL,
  embedModel: env.EMBED_MODEL,
  embedApiKey: env.EMBED_API_KEY,
  embedDims: env.EMBED_DIMS,
  embedMaxDistance: env.EMBED_MAX_DISTANCE,
  // Vision may live on a different provider (Groq rotated its vision models
  // off) — defaults keep the Groq client so a future Groq vision model needs
  // only VISION_MODEL.
  visionApiKey: env.VISION_API_KEY ?? env.GROQ_API_KEY,
  visionBaseUrl: env.VISION_BASE_URL ?? env.GROQ_BASE_URL,
  imageMaxBytes: env.IMAGE_MAX_BYTES,
  // Saying a companion's name in text counts as addressing it. Kill switch
  // for if casual name-drops get noisy.
  wakeWord: env.WAKE_WORD !== "0",
  // Conversational engagement: addressed users stay "in conversation" for the
  // TTL and get a mid-tier reply bonus without re-mentioning. Kill switch and
  // window size are separate knobs — engagement is what makes the bot chattier.
  engagement: env.ENGAGEMENT !== "0",
  engagementTtlMs: env.ENGAGEMENT_TTL_MS,
  replyBurst: env.REPLY_BURST,
  replyRefillMs: env.REPLY_REFILL_MS,
  regenDailyCap: env.REGEN_DAILY_CAP,
  // BYOK: AES-256-GCM master passphrase (SHA-256-derived in secrets.ts) and the
  // hosted-mode flag that turns off the env-key fallback for keyless guilds.
  keyEncryptionSecret: env.KEY_ENCRYPTION_SECRET,
  requireGuildKeys: env.REQUIRE_GUILD_KEYS === "1",
  dmLlmDailyCap: env.DM_LLM_DAILY_CAP,
  dmContextMessages: env.DM_CONTEXT_MESSAGES,
  maxCompanionChainDepth: env.MAX_COMPANION_CHAIN_DEPTH,
  siteUrl: env.SITE_URL,
  avatarUploadSecret: env.AVATAR_UPLOAD_SECRET,
  // Hosted credits — free/premium daily refill floors, the fleet
  // circuit breaker, the low-balance DM threshold, and the unlinked-prompt
  // cooldown. spendCredits applies grants lazily under the account row lock.
  freeDailyCredits: env.FREE_DAILY_CREDITS,
  premiumDailyCredits: env.PREMIUM_DAILY_CREDITS,
  hostedDailyLlmCap: env.HOSTED_DAILY_LLM_CAP,
  hostedBackgroundShare: env.HOSTED_BACKGROUND_SHARE,
  fleetPremiumDailyRevenueUsd: env.FLEET_PREMIUM_DAILY_REVENUE_USD,
  fleetCostPerHostedCallUsd: env.FLEET_COST_PER_HOSTED_CALL_USD,
  fleetCapSafetyFactor: env.FLEET_CAP_SAFETY_FACTOR,
  fleetCapMaxBonus: env.FLEET_CAP_MAX_BONUS,
  lowCreditAlert: env.LOW_CREDIT_ALERT,
  linkPromptCooldownMs: env.LINK_PROMPT_COOLDOWN_MS,
  onboardingFreeTurns: env.ONBOARDING_FREE_TURNS,
  marketplaceChannelId: env.MARKETPLACE_CHANNEL_ID,
  marketplaceModChannelId: env.MARKETPLACE_MOD_CHANNEL_ID,
  adoptionCooldownMs: env.ADOPTION_COOLDOWN_MS,
  freeAdoptionSlots: env.FREE_ADOPTION_SLOTS,
  freeListingSlots: env.FREE_LISTING_SLOTS,
  marketplaceReportFlagThreshold: env.MARKETPLACE_REPORT_FLAG_THRESHOLD,
  marketplaceModRoleIds: (env.MARKETPLACE_MOD_ROLE_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  marketPublishDailyCap: env.MARKET_PUBLISH_DAILY_CAP,
  marketReportDailyCap: env.MARKET_REPORT_DAILY_CAP,
  marketAdoptDailyCap: env.MARKET_ADOPT_DAILY_CAP,
  marketNewTagDays: env.MARKET_NEW_TAG_DAYS,
  marketTopRatingAvg: env.MARKET_TOP_RATING_AVG,
  marketTopRatingMin: env.MARKET_TOP_RATING_MIN,
  marketTrendingCount: env.MARKET_TRENDING_COUNT,
  marketTrendingWindowH: env.MARKET_TRENDING_WINDOW_H,
  // Partner-server marketplace deployments — kill switch for the whole
  // multi-server layer (see ops.ts deployments). Command registration,
  // handlers, and the sync sweep all no-op when unset.
  marketDeployEnabled: env.MARKET_DEPLOY_ENABLED === "1",
  characterImportCap: env.CHARACTER_IMPORT_CAP,
  chatImportCap: env.CHAT_IMPORT_CAP,
  chatImportMaxWindows: env.CHAT_IMPORT_MAX_WINDOWS,
  // The verdict schema is tiny — a small fast model is plenty and keeps the
  // per-reply screen on adopted companions off the latency path. On Groq the
  // default is gpt-oss-20b; any other provider falls back to GROQ_MODEL.
  safetyModel: env.SAFETY_MODEL
    ?? (env.GROQ_BASE_URL.replace(/\/+$/, "") === "https://api.groq.com/openai/v1" ? "openai/gpt-oss-20b" : env.GROQ_MODEL),
  // House ops — see ops.ts. houseGuildId unset disables the whole layer
  // (intents, listeners, watchdog never activate).
  houseGuildId: env.HOUSE_GUILD_ID,
  houseMemberRoleId: env.HOUSE_MEMBER_ROLE_ID,
  houseWelcomeChannelId: env.HOUSE_WELCOME_CHANNEL_ID,
  houseRulesChannelId: env.HOUSE_RULES_CHANNEL_ID,
  houseAnnounceChannelId: env.HOUSE_ANNOUNCE_CHANNEL_ID,
  houseVerifyChannelId: env.HOUSE_VERIFY_CHANNEL_ID,
  houseAdopteesChannelId: env.HOUSE_ADOPTEES_CHANNEL_ID,
  // Floodgate thresholds — active threads under #adoptees AND guild-wide
  // (the ~1000 ceiling counts tickets/forum posts too). Warn posts the
  // "host your own" card; the gap to clear is hysteresis so it doesn't flap.
  houseThreadWarnCount: env.HOUSE_THREAD_WARN,
  houseThreadClearCount: env.HOUSE_THREAD_CLEAR,
  houseGuildThreadWarnCount: env.HOUSE_GUILD_THREAD_WARN,
  houseGuildThreadClearCount: env.HOUSE_GUILD_THREAD_CLEAR,
  // Inactivity window after which adoptee threads auto-archive out of the
  // active pool. 3d default — validated to Discord's allowed minute set.
  adopteeThreadArchiveMinutes: env.ADOPTEE_THREAD_ARCHIVE_MINUTES,
  houseInviteUrl: env.HOUSE_INVITE_URL,
  houseVerifyNudge: env.HOUSE_VERIFY_NUDGE !== "0",
  opsChannelId: env.OPS_CHANNEL_ID ?? env.MARKETPLACE_MOD_CHANNEL_ID,
  // High-signal alerts (raid, breach, kicks, filed reports) can route to a
  // separate channel so they don't drown in the ops log — falls back to
  // OPS_CHANNEL_ID when unset.
  opsAlertChannelId: env.OPS_ALERT_CHANNEL_ID,
  opsUserIds: (env.OPS_USER_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  opsRepoDir: env.OPS_REPO_DIR,
  automodBurstCount: env.AUTOMOD_BURST_COUNT,
  automodBurstWindowMs: env.AUTOMOD_BURST_WINDOW_MS,
  automodMentionMax: env.AUTOMOD_MENTION_MAX,
  automodNewAccountDays: env.AUTOMOD_NEW_ACCOUNT_DAYS,
  automodRaidJoins: env.AUTOMOD_RAID_JOINS,
  automodRaidKick: env.AUTOMOD_RAID_KICK === "1",
  automodKickThreshold: env.AUTOMOD_KICK_THRESHOLD,
  hostHeapPct: env.HOST_HEAP_PCT,
  hostDiskPct: env.HOST_DISK_PCT,
  hostLagMs: env.HOST_LAG_MS,
  hostHealthIntervalMs: env.HOST_HEALTH_INTERVAL_MS,
};
