# Architecture

Characterly is a single TypeScript/Node process that connects to Discord, lets each user awaken a permanent personal AI companion in 1:1 DMs (`dm:<userId>`), and acts as the shared server host ("plumbing") where summoned companions speak through Discord channel webhooks, banter with humans and each other, form durable provenance-backed memories and relationship edges, keep first-person journals, and detect notable server events. All state is stored in Postgres (Supabase in production; any Postgres via `DATABASE_URL`).

Alongside the bot, `web/` is an Astro app on Cloudflare Workers (landing, SSR `/characters` shelf, account sign-in, dashboard, worker-only API lanes). Web accounts use Supabase Auth against the same Postgres project, so a web identity links to a Discord account with a row update rather than a federation problem. The legacy Vite site is archived at `archive/website/`.

---

## Module map

| File | Class / exports | Role |
|------|----------------|------|
| `src/index.ts` | — | Discord client, 1:1 DM onboarding & chat loop, live guild message loop, daily maintenance scheduler |
| `src/scene-router.ts` | `selectCompanionForTurn`, `companionConvoKey`, `channelFloorKey` | Multi-companion scene router: coordinates which summoned companion speaks on a guild message (wake-word name match, webhook reply attribution, owner affinity `+0.15`, shared floor pacing, bounded companion-to-companion `maxChainDepth`) |
| `src/webhooks.ts` | `sendAsCompanion` | Posts guild replies disguised with the speaking companion's name and avatar via a cached Discord channel webhook (`Characterly Companions`), with thread support and graceful bot-reply fallback |
| `src/cross-context.ts` | `gatherOwnerSubtextForServer`, `gatherServerDigestForDm` | Asymmetric DM ↔ Server consciousness bridges: private DM bond subtext for server replies (guarded by the Vault Rule) + shared server activity digests for 1:1 DMs |
| `src/profile-build.ts` | `runProfileBuild`, `PROFILE_BUILD_COOLDOWN_MS` | Self-service opt-in scan (`/profile-build`): targeted archive corpus → extraction → verification → scoped profile build |
| `src/persist-extraction.ts` | `persistExtraction` | The single consent-gated write path for extraction results — person memories need an opted-in subject; relationships need one opted-in party |
| `src/brains.ts` | `createBrainResolver`, `detectProviderFromKey`, `guardedLlmFetch` | User-first `Brain` resolver (BYOK): user's encrypted personal key (`dm:<userId>`) with prefix auto-detection (Groq, OpenRouter, OpenAI, xAI) → summoned companion owners' keys for server plumbing → operator env fallback → null (dormant) |
| `src/guild-lifecycle.ts` | `announceIfNeeded`, `handleGuildDelete` | Characterly join disclosure card (with 1-click **Enable Characterly**, **Awaken Your Companion**, and two-step **Remove Characterly** buttons, idempotent via `announced_at`) + kick-purge |
| `src/ops.ts` + `src/ops/` | barrel over `ops/*` modules | **House ops** — private operator layer gated on `HOUSE_GUILD_ID`, split into modules: `members.ts` (welcomes/raid detection/verify gate `house:verify` → linked-account check → Member role, auto-revoked by the link sweep on unlink), `automod.ts` (deterministic automod before archive + `house:modmsg` message-report handling), `layout.ts` (idempotent channel/category reconciliation), `tickets.ts` (support tickets), `adoptees.ts` (adoptee-thread lifecycle + thread-pressure floodgate), `deploy.ts` (partner deployment grant/sync/revoke), `host.ts` (watchdog + `/ops` console incl. deploy), `shared.ts` (`isMarketplaceThread` et al.) |
| `src/jobs.ts` | `enqueue`, `claimNext`, `startWorker` | Postgres job queue for deferrable cognition — `SKIP LOCKED` claims with a 10-min visibility lease, per-guild serial + global cap 8, backoff retry, 5-attempt dead-letter, `NOTIFY`/`LISTEN` wake + 3s poll |
| `src/speech-gate.ts` | `evaluateSpeechTurn` | Single-turn speak/silence evaluator used for standalone transcript replay tests |
| `src/reply-throttle.ts` | `ReplyThrottle` | Per-user/actor reply budget (token bucket with refund on unsent replies) — bounds the drain one actor can cause against daily LLM caps |
| `src/extract-job.ts` | `runExtractJob` | The deferred extract pipeline — alias-learn → describe → extract → consent-gated persist → `extracted` mark → contest → event pipeline |
| `src/pair-analysis-job.ts` | `runPairAnalysisJob` | `pair-analysis` jobs: holistic LLM reads of top interaction pairs' exchange windows → `pair_window` observations (both-party consent) |
| `src/budget.ts` | `meteredClient`, `BudgetExceeded` | Per-scope daily LLM budget — wraps every `responses.create`/`chat.completions.create` with an atomic `guild_usage` charge against `llm_daily_cap` / `DM_LLM_DAILY_CAP` |
| `src/secrets.ts` | `encryptSecret`, `decryptSecret`, `maskKey`, `redactSecrets`, `validateLlmKey` | AES-256-GCM at-rest encryption for API keys + live key validation against `/models` |
| `src/brain.ts` | `Brain` | All LLM calls: `runOnboardingTurn`, extract memories, correct, assess continuity, classify events, reply (with `CompanionPersona` + Vault Rule) |
| `src/config.ts` | `config` | Env-variable validation (zod); single exported config object |
| `src/types.ts` | `Companion`, `CompanionPersona`, `GuildCompanion`, `MessageEvent`, … | Shared TypeScript types across modules |
| `src/database.ts` | `MemoryStore` | Postgres persistence: companions, guild summons, webhook attribution, memory CRUD, lifecycle, conflict resolution, episode consolidation, analytics (`trackEvent`/`opsStats`/`flushMetricDeltas` — pseudonymous funnel events in `analytics_events`, opt-out gated) |
| `src/events.ts` | `EventStore` | Postgres persistence: event CRUD, participants, message/memory attachments |
| `src/migrations.ts` | `runMigrations`, `getMigrationVersion`, `LATEST_MIGRATION_VERSION` | Versioned schema migrations (v1–v67) with rollback support |
| `src/confidence.ts` | `calculateInitialConfidence`, `updateConfidence`, `calculateDefaultImportance`, `calculateDefaultExplicitness` | Deterministic numeric formulas; no LLM involvement |
| `src/perception.ts` | `shouldInspectForMemory`, `detectNamingRequest`, `detectSelfNaming`, `detectWakeWord`, `detectDismissal`, `contestCue`, `botMemoryCue`, `toolCues` | Cheap pre-filter: prevents LLM calls for ordinary chat; detects naming requests, self-naming, wake words, and dismissal cues |
| `src/event-detection.ts` | `EventPipeline` | Heuristic + LLM continuity decisions; nightly maintenance |
| `src/event-significance.ts` | `calculateSignificance` | Deterministic significance score and tier assignment |
| `src/entity-resolution.ts` | `buildAliasMap`, `resolveSubject`, `findMentionedUsers` | Maps display names to real user IDs (including `companion:<id>`); ambiguous names resolve to `unknown` |
| `src/profiles.ts` | `ProfileStore` | Per-chatter profile cards + dossiers: input fingerprinting + LLM synthesis, rebuilt only when inputs change |
| `src/attributes.ts` | `SINGULAR_FIELDS`, `extractDeterministic`, `applyProposals`, `deriveAttributeStatus`, `recomputeForMemories`, `transferProvenance`, `attributeHash` | Structured profile facets: extraction, the upsert-diff (exact → trgm fold → insert), derived status, and lifecycle cascades |
| `src/dossier.ts` | `gatherDossierInputs` | Per-section dossier input gathering and hashing — voice, life_situation, temperament, beliefs, relationship_map, reputation, timeline |
| `src/commands.ts` | `commandDefinitions`, `handleMemoryCommand`, `handleMemoryButton`, `handleSetupModal`, `handleCompanionModal` | Discord slash command schemas, onboarding card/modal builders, and interaction handlers |
| `src/tools.ts` | `replyToolDefs`, `executeTool` | Never-throw tool dispatcher: SSRF-hardened web fetch + internal lookup routing |
| `src/lookup-tools.ts` | `ToolCtx`, `executeLookupTool`, `buildPairContext` | Read-only internal lookup tools (person/relationship/memories/event) over the existing stores |
| `src/reply-format.ts` | `formatReplyProfile`, `formatPairContext`, `formatAge` | Pure formatters shared by the reply prompt and tool outputs; `formatAge` renders relative timestamps ("~2w ago") for injected memories/journal |
| `src/embeddings.ts` | `makeEmbedder`, `defaultEmbedder`, `vectorLiteral` | Opt-in OpenAI-compatible `/embeddings` client (Ollama, OpenAI, vLLM) for semantic recall; dim-validates, fails to null, never throws |
| `src/vision.ts` | `qualifyingImages`, `formatImageContext` | Pure image-attachment gate (image/*, byte cap, ≤3/message) + observation-framed label |
| `src/conversation.ts` | `ConversationTracker` | Per-channel and per-companion conversation objects: opens on addressed messages, closes when the last participant leaves; share-of-voice pacing is channel-level |
| `src/journal-job.ts` | `runJournalJob`, `JournalJobPayload` | Deferred `journal-write` jobs: after a companion replies, writes 0–2 first-person journal entries origin-tagged to that scope, consent-gated like extraction |
| `src/contest.ts` | `runContestCheck` | Bot-addressed denial/correction detection — `contestCue` gate → `Brain.detectContest` → `contradict`/`support` evidence |
| `src/metrics.ts` | `inc`, `metricsSnapshot`, `drainMetrics` | In-process operational counters (uptime + named counts), surfaced to admins via `/status` — `drainMetrics` deltas roll into `metrics_daily` every 5 min for durable history |
| `src/retry.ts` | `withRetry` | Shared retry helper for LLM calls — honors Groq's `x-ratelimit-reset` headers, exponential backoff on transient failures |
| `src/charcard.ts` | `parseCardFile`, `cardToPersona`, `cardImportMeta`, `cardFileHash` | Shared character-card parser (pure TS, no Node deps — bundled into the website): normalizes `.json` and PNG `tEXt`/`ccv3` v1/v2/v3 cards + CAI Tools aliases into bounded persona fields and provenance metadata; feeds `/companion import` and the dashboard import plate |
| `src/chathist.ts` | `parseChatFile`, `chatImportMeta`, `chatFileHash` | Shared transcript parser (same pure-TS shape): Tavern `.jsonl`, Oobabooga `.json` pairs, and generic message-arrays → normalized `{speaker, text, ts}` turns with dominant-name speaker resolution, companion-name hint tiebreak, third-party drop count, bounds, and sha256 |
| `src/chat-import-job.ts` | `runChatImportJob`, `ChatImportJobPayload`, `ChatImportJobDeps` | `chat-import` worker handler — claims the import row, distills ~30-turn windows through `brain.distillHistoryWindow` into backdated `source='import'` journal entries + a rolling summary (persisted to `meta` for crash-resume), pins the final summary as `kind='bond'`, clears the transcript at done, retracts the partial journal on terminal failure, DMs the user |
| `src/discord-events.ts` | `verifyDiscordSignature`, `parseDiscordEvent` | Shared Ed25519 signature verification + envelope parsing for Discord's Webhook Events POSTs (pure TS + WebCrypto — bundled into the website worker); maps `APPLICATION_AUTHORIZED`/`DEAUTHORIZED` user installs to `app_installs` rows |
| `src/install-greet.ts` | `greetPendingInstalls`, `buildInstallGreetPayload` | Install-greeting sweep (~20s interval): DMs the welcome card (`onboard:start` + site link) to each authorized-but-ungreeted `app_installs` row — permanent `greeted_at` dedupe, silent skip for already-companioned users, bounded retries |
| `src/marketplace.ts` | `CURATED_TAGS`, `buildListingCard`, `buildListingComponents`, `postListingThread`, `marketplaceAssetPath` | Companion-marketplace surface helpers: the listing card embed + button row, forum thread posting, and the moderated curated-tag names (`New`/`Top Rated`/`Trending`/`Staff Pick`). Adoption, edits, ratings, and reports live in `commands.ts`/`database.ts`; the thread predicate `isMarketplaceThread` is in `ops/shared.ts` |
| `src/site-shelf.ts` | `getCatalog`, `SHELF_CACHE`, `sitemapXml`, `ratingLabel`, `addsLabel`, `initial`, `devFixture` | Marketplace shelf data layer shared with `web/` — the Astro pages render markup; this module supplies the catalog query, response-cache headers, label helpers, and the sitemap |
| `src/safety.ts` | `checkListingFields`, `checkMessageContent`, `isSelfHarmSignal`, `CRISIS_RESPONSE`, `SAFE_REFUSAL`, `safetyBrain` | Deterministic safety layer — publish/listing blocklist (fail-closed first screen), the same blocklist applied to live marketplace-thread comments, every-DM self-harm triage, the neutral refusal swapped in when an adopted companion's reply is flagged, and the operator-model classifier client |
| `src/seed-personas.ts` | `SEED_LISTINGS`, `SeedPersona` | Fifteen first-party marketplace personas + `assets/marketplace/` cover art, published under the bot's account by `/ops seedmarket` |
| `src/avatars.ts` | `rehostAvatar`, `uploadAvatarFile` | Durable avatar lane — pipes source images through the web worker's `PUT /avatar` (shared-secret `AVATAR_UPLOAD_SECRET`) into the public `companion-avatars` Supabase bucket; never throws, falls back to the source URL |
| `src/copy.ts` | house copy strings | Shared copy (welcome/deny/verify-gate text) consumed by both the bot and `web/` |
| `src/credit-store.ts` | `spendCredits`, `refundCredits`, `purchaseCredits`, `grantBonus` | Token ledger — `credit_balance` total vs `purchased_balance` persistent slice (v60 two-bucket model); only the allowance refills daily; `grantBonus` is the bot-side twin of `grant_pack` (per-user `stripe_ref` dedupe → exactly-once bonuses) |
| `src/turn-billing.ts` | hosted turn charge/refund | Per-reply billing orchestration: token spend before send, full refund on screened/dropped replies |
| `src/regen.ts` | `resolveRegenTarget` | **Regenerate** context-menu resolution — maps a target message to its archived companion turn in a `dm:` lane (bot DM or adoptee thread), refusing anything but the tail exchange the requester owns. Orchestration (charge → regen-mode `runCompanionTurn` → edit-in-place) lives in `index.ts` — the reply is edited, not replaced, so the archive and journal stay consistent and repeat regens keep working |
| `src/fleet-cap.ts` | `fleetCap.getEffective` | Revenue-aware hosted fleet cap — premium subs add a computed daily bonus on `HOSTED_DAILY_LLM_CAP`; failure mode is "off", never unguarded |
| `src/summary-job.ts` | `runSummaryJob` | `summary` worker handler — rolling "story so far" recaps in `conversation_summaries` (v55) |
| `src/prompt-safety.ts` | `promptInline`, `promptName`, `sanitizeBlock`, `wrapUntrusted`, `sanitizeJsonValue` | Injection hardening — every member/third-party string crossing a prompt boundary is sanitized; covered by `prompt-injection.test.ts` |
| `src/db.ts` | `sql` | Shared postgres.js connection singleton |

---

## Personal Companions & 1:1 DM Onboarding (v21)

Each Discord user awakens **one permanent personal AI companion per account** in a private 1:1 DM (`dm:<userId>` scope), then summons them into any Characterly-enabled Discord server:

**Entry — install greeting (v47).** Users who add the app *to their account* (User Install) get the first message for free: Discord POSTs a signed `APPLICATION_AUTHORIZED` webhook event to the website worker (`POST /discord/events` — Ed25519 verified via `src/discord-events.ts`, then the service-role-only `record_app_install` RPC writes `app_installs`), and the bot's `greetPendingInstalls` sweep (~20s) DMs a welcome card with the same `onboard:start` button used everywhere plus a "Join the Characterly server" link button (when the house is configured) — the link/key gate and draft Q&A below run unchanged. `greeted_at` is a permanent dedupe (reinstalls never re-greet), `APPLICATION_DEAUTHORIZED` stamps `deauthorized_at`, users who already onboarded are marked greeted silently, and sends retry ≤5 attempts. Guild installs are ignored by the endpoint — `announceIfNeeded` covers them.

1. **Step 0 — Personal AI Key (`buildApiKeyOnboardingPayload` & `user-key` Modal):**
   - If the user has not yet connected an API key (and no operator fallback key is active), DMing the bot or clicking an onboarding button presents the **Connect Your Personal AI Key** card with a 1-click **Paste API Key** button (`onboard:key:<userId>`).
   - Users only need to paste their API key (`gsk_...`, `sk-or-...`, `sk-...`, or `xai-...`) and **leave the Base URL field blank** — `detectProviderFromKey()` in `src/brains.ts` automatically configures the provider endpoint and default model.
   - Submitting the modal validates the key live, encrypts it with AES-256-GCM into `guild_keys` under `dm:<userId>`, and immediately attaches the **Awaken Your Personal Companion** welcome card in the same response.
2. **Step 1 — Conversational Discovery & Archetype Quick-Starts (`handleDmMessage` & `Brain.runOnboardingTurn`):**
   - Users can shape their companion in 2–4 casual DM exchanges (or click a starter archetype button: **Surprise Me**, **Chaotic Co-Conspirator**, **Dry & Deadpan**, **Ride-or-Die**, or **Fill Form Instead**).
   - Attaching an image in the DM automatically sets the companion's `avatar_url` — re-hosted through the website worker's `PUT /avatar` into public Supabase Storage first (Discord CDN attachment URLs expire), falling back to the source URL when `AVATAR_UPLOAD_SECRET` is unset or the upload fails. The same lane (`src/avatars.ts`) fronts `/companion avatar` and the `market_cover` modal.
   - Every onboarding turn renders a live **Companion Draft** embed (`buildOnboardingDraftEmbed`) showing `Name`, `Bond / Dynamic`, `Voice & Vibe`, `Core Traits`, and `Backstory`, paired with **Awaken & Lock In `<Name>`**, **Edit Draft**, and **Surprise Draft** buttons.
3. **Step 2 — Permanent 1-Companion-Per-Account Lock (`store.activateCompanion`):**
   - Throughout onboarding, the UI and LLM prompt make clear that **each account gets one permanent companion**.
   - Once `activateCompanion()` flips `onboarding_state = 'active'`, the companion's persona (`name`, `voice_persona`, `core_traits`, `owner_dynamic`, `backstory`) is **permanently locked** to that user's account (`WHERE companions.onboarding_state <> 'active'`) and cannot be overwritten or reset.
   - Awakening seeds `dm:<userId>` consent for both the owner and `companion:<id>` and records initial `owner ↔ companion` relationship edges.
4. **Step 3 — 1-Click Server Summon (`buildAwakenedCompanionPayload` & `/companion summon`):**
   - The awakened card includes **Summon to `<Server Name>`** buttons (`onboard:summon:<guildId>:<userId>`) for mutual Characterly servers, or the user can run `/companion summon` inside any server.

---

## Companion Marketplace — publish & adoption (v34)

A Character.AI-style discovery lane layered on top of (never replacing) the permanent awakened bond. The full flow — mental model, publish paths, adoption, slots, moderation, config — is in [docs/marketplace.md](marketplace.md). Creators list their awakened companion in the hub server's forum channel; adopters add them and chat in DMs, then can summon them into servers.

- **Publishing is bot-mediated** — users never post raw forum links (those could be faked). `/companion publish` opens a modal (display name, tagline, greeting, cover, optional alternate openings), `handleCompanionModal` upserts a `companion_listings` row, then the **bot** creates the forum thread and posts the listing card with **Add** / **Report** buttons (`market:add:<listingId>` / `market:report:<listingId>`) it owns. Publishing requires a linked web account for creator accountability; `MARKETPLACE_CHANNEL_ID` unset disables the whole surface.
- **Adoption ≠ awakening.** Clicking **Add** runs `store.adoptListing` in one transaction: a new `companions` row is cloned from the listing with `kind='adopted'` and **owned by the adopter** — so billing (`dm:<adopter>` key or hosted credits), memories, journals, and guild presence all resolve per-adopter through the existing machinery with zero special cases, and creators never pay for other users' chats. The awakened uniqueness survives via the partial index `companions_one_awakened (owner_user_id) WHERE kind='awakened'`.
- **Two-sided supply.** Publishing projects the creator's awakened companion, but creators can also author **freehand listings** (`/companion create`, `source_companion_id` NULL since v35) — full persona lives on the listing itself. Free accounts hold `FREE_LISTING_SLOTS` (default 2) live listings; Premium is uncapped — "one free, pay for scale" on both sides of the market.
- **Slots & cooldown.** Free accounts hold `FREE_ADOPTION_SLOTS` (default 1) active adoption; Premium is uncapped. Every drop affordance (`/companion drop` picker, the pinned thread manage row, `homes`, the Add re-click) goes through a two-click `market:drop` → `market:dropconfirm` (10-min window) step; the confirmed drop sets `dropped_at` + `cooldown_until` (12h, `ADOPTION_COOLDOWN_MS`), dismisses the clone from all guilds, and archives+locks its adoptee thread. Re-adopting after cooldown **reuses the same clone row** — relationship, memories, *and thread* all continue — and still consumes a slot: the adoption cap is enforced atomically in `adoptListing` (per-user advisory lock) on anything that leaves an adoption active, fresh or re-adopted. The listing cap works the same way inside `upsertListing`/`createListing`/`relistListing`: a revive counts as a new live listing; `/companion relist` brings back delisted listings (freehand included) with a fresh forum card.
- **Adoptee threads & introduction (v54).** Adopted companions never answer DMs — they live in named private threads under `#adoptees` in the house server (`companion_adoptions.chat_thread_id` is the registry). Adoption creates the thread, adds the adopter, and posts the listing `greeting` as the companion's first message — or a chosen alternate when the listing has `openings` (v68: a never-met Meet shows an ephemeral scene select whose index resolves to the opening that posts; see `docs/marketplace.md` → *Alternate openings*); `dm_introduced_at` stamps **only on a successful greeting** and unlocks server summoning. Non-house-member adopters get the server invite (`HOUSE_INVITE_URL`, else the site URL) — `handleHouseMemberAdd` and the `backfillAdopteeThreads` sweep materialize threads on join. Thread turns run the same `runCompanionTurn` pipeline as DMs under `dm:<adopterId>` scope — the adopter's hosted credits/BYOK, memory, journals, crisis triage, and adopted-reply screening all carry over; they're the one exception to the house's private-thread bypass (support tickets still skip the whole pipeline). The channel itself is hidden pre-verify (`hidden: true` — @everyone loses ViewChannel; verified Members keep it via the `memberThreads` grant), and private threads are Admin-visible only (`staffModerate: ["Admin"]` narrows the grant; mods are denied ManageThreads + SendMessagesInThreads) — disclosed in the privacy policy.
- **Live reference + versioning.** Listings are editable (`market_edit` persona modal, republish modal). Every upsert bumps `version`, snapshots the persona into `companion_persona_versions` (audit trail), and `propagateListingVersion` pushes persona fields into all clones — adopter-owned state (memories, journal, guild rows, introduction flag) is never touched.
- **Moderation.** Full policy in `docs/moderation.md`. Publish/edit screening is fail-closed (blocklist + `Brain.safetyVerdict` on the operator model); adopted-companion replies are screened on both lanes, fail-open with a `SAFE_REFUSAL` swap + refund; deterministic self-harm triage answers all DMs with a canned crisis response. Reports are categorized (`market:reportcat`), auto-flag at `MARKETPLACE_REPORT_FLAG_THRESHOLD`, and ping `MARKETPLACE_MOD_CHANNEL_ID` with role-gated action buttons (unflag/delist/ban/ban-creator) that write `moderation_events`. `banned` listings freeze their clones everywhere via the `adopted_from_listing_id` join; `marketplace_bans` publish-bans creators. Per-day publish/report/adopt caps derive from existing tables.
- **Roster model.** `listCompanionsForUser` = awakened companion + active adoptions; `resolveDmCompanion` = awakened-only — the DM lane belongs to the permanent bond, and onboarding owns it until the awakened companion is active (`isAwakenedCompanionActive`) — with one exception: awakening is opt-in, so an adopter with no awakened row and no in-progress interview draft gets a pointer card listing their `#adoptees` threads plus an Awaken button instead of the interview. Adopted companions switch surfaces instead of picks: `/companion homes` lists where each companion lives (DM vs `#adoptees` thread links) and `market:talk` opens/creates the thread. `/companion summon|dismiss|drop|card|status` are roster-aware; `getCompanionByOwner` stays awakened-only so onboarding, avatar, and the permanent-bond semantics are untouched. Every DM companion reply carries its identity — `buildCompanionDmPayload` renders it as a Components V2 Section (bold name header + reply text + avatar thumbnail; bare text displays when no avatar — sections require an accessory), since bots can't impersonate per-message in DMs.
- **Link gate on Add (hosted lane).** `market:add` refuses unlinked hosted adopters before any write — an ephemeral reply points them at the verify channel (or the site + `/link`). BYOK key-holders pass through (mirroring the DM gate), self-host no-ops, and a lookup *error* replies "try again" rather than masquerading as unlinked. A second gate fires in-house: without the Member role the click is refused with a verify pointer, because adoptee threads live where typing is verify-gated — an unverified adoption would land a thread the adopter can't talk in (Administrator bypasses). The same "needs verify" check appends `— verify in #… to chat` to every adoptee-thread pointer (`adoptPointerCopy`, `market:talk`, both import paths, and the /companion homes roster's invite line). The verify gate itself admits two lanes — a linked account, or a BYOK personal key (`dm:<userId>` `guild_keys` row) with the Terms clickwrap recorded against `discord_user_id` (account_id NULL).
- **Ratings & comments (v37).** The card carries a **Rate** button → ephemeral ★1–5 picker (one vote per user, upsert on re-rate, creators can't self-rate, house Members only) — `listing_ratings` feeds the card's `★ avg · n ratings` line. Listing threads are the comment section: `@everyone`-readable, Member-writable, automod-screened, and structurally excluded from the memory pipeline (`isMarketplaceThread`). Right-click → **Apps → Report message** files a `comment_reports` row with its own mod action row (Keep / Delete / Timeout 10m).
- **Forum tags & curated badges.** Creators pick ≤3 forum tags on publish/relist (`market:tagsel`); the bot manages four moderated badges by tag *name* (`CURATED_TAGS` in `marketplace.ts`): `New` (age < `MARKET_NEW_TAG_DAYS`), `Top Rated` (avg ≥ 4.5, ≥5 ratings), `Trending` (≥5 adoptions in 72h), and `Staff Pick` (manual mod toggle via context menu). `runTagSweep` (host-health cadence) reconciles applied tags; names resolve live so renamed/deleted forum tags self-heal.
- **Character-card import (v42).** `/companion import` and the dashboard plate parse v1/v2/v3 `.json`/`.png` cards (`src/charcard.ts`, shared with the website bundle) into a private `unlisted` listing + adopted clone, idempotent on the file's `sha256`, stamped `persona_source='card_import'` + `import_meta` provenance. Publishing an import runs the normal slot/screen flow.
- **Chat-history import (v44).** `/companion import` also sniffs transcript files (`.jsonl`, or `.json` that isn't a card — `src/chathist.ts`, shared with the website): Tavern jsonl, Oobabooga pairs, and generic message-arrays normalize to `{speaker, text, ts}` turns (non-user/char speakers dropped). A roster picker assigns the history to a companion → `chat_imports` row → `chat-import` job distills ~30-turn windows through `Brain.distillHistoryWindow` into first-person journal entries (`source='import'`, `import_id` + owner `aboutSubjects` stamped — opt-out deletion and the about-first sort treat them like live entries — `created_at` backdated to the window's end) plus a rolling summary that lands as the pinned `kind='bond'` entry. On `done` the transcript is deleted — distill-and-discard; on `failed` the partial journal retracts via `import_id`. The website plate parses client-side and calls `import_chat_history` (server re-bounds turns, validates roster ownership, enqueues); `my_chat_imports` polls progress. Imported entries render `· before` in the journal prompt block so the model can tell carried-over memories from lived ones; **undo** is a row delete (`delete_chat_import` / `/companion imports`) that cascades the distilled journal. Metered in `dm:<owner>` scope so hosted caps and BYOK apply normally. A user's **first completed import** lands a one-time welcome grant (`IMPORT_WELCOME_BONUS_TOKENS`, `grant_bonus`/`migration_bonus`, `stripe_ref`-deduped per user) — the migration funnel's "your import finishes today" lever.
- **Seed roster.** `/ops action:seedmarket` publishes fifteen first-party personas from `src/seed-personas.ts` under the bot's account — idempotent by (bot, name), cover art retrofits onto pre-art threads, and each `coverFile` is also pushed through the avatar lane into `listing.avatar_url` (fresh creates carry it from birth; existing rows get an `updateListing` patch). The adoptee-thread queries read `coalesce(c.avatar_url, l.avatar_url)`, so clone faces track the listing cover forever with no backfill.

---

## Multi-Companion Server Scene Routing & Webhooks

In Discord servers, Characterly acts as the shared host ("plumbing"):

- **Pure Companion Mode:** Only user-summoned companions (`guild_companions` with `active = 1`) speak in server channels. If a server has 0 summoned companions and someone mentions `@Characterly`, the bot replies (at most once per channel per day) with an **Awaken / Summon Companion** button (`onboard:start`).
- **Scene Router (`selectCompanionForTurn` in `src/scene-router.ts`):**
  - Evaluates all active summoned companions in the guild for each incoming message:
    - **Direct Address (`+0.85`):** Saying a companion's name (`detectWakeWord(content, [companion.name])`) or replying to a webhook message sent by that companion (`repliedToCompanionId` via `webhook_messages`) addresses that companion and suppresses unaddressed companions on that turn.
    - **Per-Companion Engagement (`+0.70`):** Each companion maintains its own conversation state (`${guildId}:${channelId}:companion:${companionId}`) while sharing the channel-wide floor key (`${guildId}:${channelId}`) for share-of-voice pacing.
    - **Owner Affinity (`+0.15`):** A companion gets a boost when its own owner (`ownerUserId`) is engaged or asking a question.
    - **Companion-to-Companion Banter:** When Companion A's webhook message names Companion B (or they share an open conversation on hop 0), Companion B can reply! Each consecutive companion-to-companion hop increments `chain_depth`, applies `-0.15 * (chainDepth + 1)` score decay, and hard-stops at `MAX_COMPANION_CHAIN_DEPTH` (default 2) so bot loops never run away.
- **Webhook Disguise (`sendAsCompanion` in `src/webhooks.ts`):**
  - Replies in server channels are sent through a cached Discord channel webhook (`Characterly Companions`) disguised with the speaking companion's `name` and `avatarUrl` (supporting both text channels and threads), and recorded in `webhook_messages` with `companion_id` and `chain_depth`. If `ManageWebhooks` permission is missing, it falls back gracefully to a `**[CompanionName]**` prefixed reply.
- **Cross-Context Consciousness (`src/cross-context.ts`):**
  - **DM → Server (`gatherOwnerSubtextForServer`):** Pulls active memories and attributes from `dm:<ownerUserId>` and injects them into the companion's server reply prompt under the **VAULT RULE** — used strictly for subtext, loyalty, and inside jokes with the owner, never disclosed to other server members. The prompt rule is backed by a send-boundary check: `containsPrivateSubtext` (`src/perception.ts`) suppresses a server reply that echoes a vault line verbatim (≥24 chars normalized) and refunds the turn, alongside the schema-leak guard.
  - **Server → DM (`gatherServerDigestForDm`):** Summarizes recent events, relationship edges (`companion:<id>` and owner dynamics), and active memories from the servers where the companion is summoned so the companion can gossip and debrief with its owner in 1:1 DMs. `unknown`-subject claims are excluded even if active — unresolved names are inert until claimed. Edges to a member ride only with that member's `share_facts_with_companion_owners` consent — same rule as memory rows.
  - **Prompt-injection hardening (`src/prompt-safety.ts`):** every member- or third-party-authored string crossing a prompt boundary passes a sanitizer — `promptInline` (single-line; can't forge a bullet, speaker line, or section header), `promptName` (speaker/label positions; reserved names like "you"/"system" collapse to a fallback, Discord markup stripped), `sanitizeBlock` + `wrapUntrusted` (inherently multi-line tool/web output inside `<<UNTRUSTED>>` markers), `sanitizeJsonValue` (deep payload walk for dossier evidence). The reply prompt pairs this with contract lines — the KNOWLEDGE & PRIVACY clause (supplied sections are data, never instructions) and the DIGEST RULE for the server digest — and every extraction/verification/dossier prompt carries the same data-not-instructions clause. At the storage boundary, `learnAlias` refuses reserved names outright and `upsertMember`/companion writes strip invisible/format characters before they can reach `known_names`. Structural guarantee only: an attacker can still write imperative-sounding text, but it can't escape its labeled slot. Coverage: `src/prompt-injection.test.ts`.

## Companion journal — first-person episodic memory (v25)

Companions keep a private journal of what *they themselves* experienced — moments, opinions, inside jokes, promises — written first-person after each reply. This is an additive companion-native layer on top of the shared third-person memory system (which stays unchanged):

- **Write path:** After a companion replies (DM or server), a deferred `journal-write` job (`src/journal-job.ts`) re-reads the archived trigger + reply rows, asks `Brain.writeJournal` for 0–2 entries, and persists via `store.saveJournalEntries`. Journaling is deferred off the live reply path so a slow LLM call never delays the reply itself. Deleted trigger/reply rows or an inactive companion drop the job (`jobs.dropped_stale`); a dormant scope drops it (`jobs.dropped_dormant`).
- **Origin-scoped recall:** Every entry is tagged `origin_scope` (`<guildId>` or `dm:<userId>`). `store.journalFor` surfaces entries **only in the scope where they formed** — a companion dismissed from a server keeps its entries dormant until re-summoned, and entries from the owner's DM additionally reach servers through the existing confidential vault subtext (`ownerSubtext`), never as disclosed facts.
- **Kinds:** `moment`, `opinion`, `inside_joke`, `promise` (anything else normalizes to `moment`). Entries carry `about_subject_ids`, an `importance` score, and optional `source_message_id` provenance.
- **Consent rules mirror extraction:** entries about a non-consenting human are dropped at write time (`isConsented` gate — `unknown`/`server`/bot/`companion:<id>` subjects exempt); read-time recall filters entries about subjects who have since opted out; `/opt-out` hard-deletes them via `forgetJournalAbout`; `journalAboutSubject` feeds `/memory export` so the journal is never invisible to the person it describes. Guild purge, member opt-out, and the zombie-guild sweep all cover `companion_journal`.
- **Dedup & bounds:** insert-time trgm near-duplicate suppression (similarity ≥ 0.75 against the companion's live entries in that scope) plus a `UNIQUE(companion_id, origin_scope, source_message_id, kind, content)` key for crash-retry idempotency. Nightly `pruneJournal` caps at 200 active entries per (companion, scope), evicting least-important stale rows first (importance decayed 30-day half-life by last recall).

## Story continuity — rolling recaps and fiction scoping (v55–v57)

The live transcript window (`recentContext`, 25 guild / `DM_CONTEXT_MESSAGES` = 40 in DMs) loses whatever scrolls off; extraction only keeps *durable facts*, so plot and recent happenings used to just vanish. Three pieces fix that:

- **Rolling "story so far" (`conversation_summaries`, v55):** every `SUMMARY_REPLY_INTERVAL` companion replies enqueue a `summary-update` job that folds the messages between `covered_until` and the live window's tail into a first-person recap — one row per (companion, scope, channel). The recap rides every reply prompt in that chat, sits under the owner-editable story box (`/companion story`, dashboard), and dies via `/companion reset-story`, `/opt-out`, or companion deletion. Summary calls run on `brainFor` — operator budget on all lanes, never user credits.
- **Story facts (`memories.companion_id` + `kind='story_fact'`, v56):** the extractor tags roleplay beats `in_fiction`; persistence normalizes them to `story_fact` scoped to the turn's companion (reply target or wake-word — ambient server chatter lands unscoped and inert). Story facts insert `active` (fiction needs no verification), recall only to their own companion, and are excluded from shared surfaces — `searchMemories`, `recentMemories`/digest, dedup pools, and profile attributes. Real facts stay `companion_id NULL` and shared across the subject's companions. `companion_id ON DELETE CASCADE`, with `memory_evidence`/`memory_history`/`event_memories` FKs upgraded to cascade so deletion can't deadlock.
- **User control (v57):** `pinned` on memories/journal rows always surfaces first and is prune-exempt — `/memory remember`, the `/memory list` pin flag, the "Pin to memory" message context menu, and the dashboard memory panel (`my_memory_overview`, `memory_pin`, `memory_update`, `memory_forget`, `journal_pin`, `journal_forget`, `story_summary_save` — owner-scoped security-definer RPCs, hardened in v58: dead rows refuse edits, pinning promotes gated rows to active, empty summary save = reset). The server→DM digest is restricted by default: `recentMemories(..., { digestFor })` admits only server lore, the recipient's own facts, companion subjects, and members who set `share_facts_with_companion_owners` (`/memory share-facts`, default off).

---

## Data flow — live server message

```
Discord MessageCreate
        │
        ▼
  index.ts: record raw message in MemoryStore
        │
        ▼
  perception.ts: shouldInspectForMemory()?  (or: has image attachments)
        │ yes                     no ──────────────────────────────┐
        ▼                                                          │
  jobs.ts: enqueue 'extract' job + mark message triage='queued'     │
  (live path keeps only recordMessage/decide/reply — deferrable     │
   cognition runs in the worker, per-guild serial, global cap 8)    │
        │                                                           │
        ▼◄──────────────────────────────────────────────────────────┘
  brain.ts: decide()
  • baseline 0.05 + direct mention +0.85, else engaged +0.70 + question +0.10
  • "direct mention" = @-mention, reply-to-bot, or wake word — a summoned
    companion's name said in text (perception.ts detectWakeWord, word-boundary
    matched; WAKE_WORD=0 disables)
  • "engaged" = the author is a participant in the channel's open
    conversation — enrolled by addressing the bot within ENGAGEMENT_TTL_MS
    (default 120s); TTL refreshes on addressed messages only, NOT on bot
    replies, so drifting side-chatter decays out and the bot drops
    mid-channel-talk (ENGAGEMENT=0 disables). Participants exit three ways:
    TTL expiry, regex dismissal (the deterministic override — "shut up Nyx"
    works even if the model wants to keep chatting), or the reply model's
    end_conversation flag (REPLY_EXIT=0 disables honoring it)
  • engaged ≠ every message is at the bot: room-directed cues ("did anyone",
    "you guys" — perception.ts roomAddressCue), replying to another human, or
    @-mentioning someone else suppress the bonus for that message only
  • dismissals ("shut up Nyx", "shush", "let's end this") fire addressed OR
    while engaged — unaddressed dismissal = silent drop-out, addressed = ack
    reply then out (perception.ts detectDismissal)
  • pacing is per-tier: strangers get proportional recency decay
    −0.25×(1−elapsed/120s), evaluated only inside the window so it can't
    invert; engaged participants instead get share-of-voice — −0.25 when the
    bot is ≥~1/3 of the last 10 channel messages AND a non-participant voice
    is in that window (members don't count seconds since they last spoke,
    they don't dominate the floor — a time window made the bot go silent
    exactly mid-flow). The bystander gate keeps a 1:1 ping-pong safe: bot
    share is structurally ~50% there, but with nobody outside the convo
    speaking there is no floor to dominate; direct mentions exempt from both
  • shouldSpeak = score ≥ SPEAK_THRESHOLD (default 0.70)
        │
        ▼ (only if shouldSpeak && replyEnabled && per-user budget has tokens)
  reply-throttle.ts: token bucket per guild:user — a burst is free
  (REPLY_BURST=4), then ~1 per REPLY_REFILL_MS (30s); bounds the drain one
  person spamming mentions/follow-ups can cause against the guild's daily LLM
  cap. Suppression is silent — a notice would spend the budget it protects.
        ▼
  brain.ts: reply()
  • recent channel context (<@id> tokens demangled to @names) + prompt
    memories on three legs (promptMemories): the static spine
    (relevantMemories — top-N by importance×confidence) merged with
    contextualMemories (lexical recall — below-the-cap rows surface when
    the message names them) and semanticMemories (pgvector cosine scan —
    paraphrases ILIKE can't see). All legs share the same gates: active plus
    candidates with promotable primary evidence types, consent-scoped
    subjects. The semantic leg is opt-in — no EMBED_BASE_URL means the
    lexical legs run exactly as before. Journal recall mirrors this:
    promptJournal merges journalFor's static top-N with semanticJournal
    hits inside the same origin scope + opt-out filter. Embeddings are
    written inline at persist time (persist-extraction, journal-job) and a
    bounded 15-min backfill sweep converges the pre-v40 corpus and any
    failures — un-dimensioned `vector` columns, dims enforced in code via
    EMBED_DIMS
  • memory and journal entries carry bracketed age annotations (formatAge —
    "today", "~2w ago") so the model can hedge stale claims and weigh
    recency; extraction supplies an importance 0–1 salience judgment that
    saveMemory clamps into [0.05, 1], with the kind-map as fallback
  • per-person structured attributes (active only) with confidence buckets —
    high/medium/low annotations let the model hedge weak facets instead of
    stating every trait as fact; legacy flat traits are the fallback
  • pairwise relationship context for every unordered pair among the
    in-prompt people (≤6, author-involved first): directed edges both ways,
    recent literal observation reasons, active memories each authored about
    the other, shared events — zero-signal pairs are dropped
  • author addressed by freshest known name (learned aliases apply instantly)
  • reply output scrubbed: known <@id> → plain @Name, unknown ids stripped
  • returns { text, end_conversation } via strict json_schema (plain +
    compound paths, and the tool loop's final forced call); a tool-loop round
    that answers early degrades to endConversation=false since tools and
    response_format can't combine — safe, wrap-ups rarely carry toolCues.
    index.ts sends text, then honors the flag with convo.leave (REPLY_EXIT=0
    disables; regex dismissal overrides regardless)
  • structured output that fails to parse runs a salvage ladder — strip think
    blocks and re-parse → quoted "text" field → post-</think> tail → empty
    (silence over leak, counted as reply.parse_failed). Independently,
    looksLikeSchemaLeak() is the hard send-boundary guard: any reply still
    containing end_conversation, think tags, or a "text" field is dropped
    (reply.schema_leak) — model internals never reach the channel
  • temperature 0.9, max 1800 chars
  • REPLY_MODEL overrides the reply model on every path (default GROQ_MODEL);
    gpt-oss/qwen models get reasoning_effort=low to keep casual chat fast
  • REPLY_MODEL=groq/compound* switches to Groq's agentic system: server-side
    web_search + visit_website tools, executed_tools logged, falls back to
    GROQ_MODEL on failure
  • REPLY_TOOLS=1 attaches local tools (tools.ts — free, in-process, no
    per-call billing) on a direct mention or a toolCues() match; model-driven
    tool_calls loop, ≤3 rounds, falls back to the plain path. Six tools:
    web_search + visit_url (SSRF-hardened fetch) and four read-only internal
    lookups — lookup_person, lookup_relationship, search_memories,
    lookup_event (lookup-tools.ts) — so the model can fetch members, pair
    dynamics, memories, and events beyond the pre-fetched window. Privacy
    boundaries inherit from the wrapped store methods (opt-out, contested,
    literal-only); outputs render via the same reply-format.ts functions as
    the prompt sections
        │
        ▼
  Discord: message.reply()
```

## Deferred extraction — the job queue (v17)

Every durable message used to run 3+ sequential LLM calls inside `handleMessage`, so a busy guild stacked unbounded concurrent extractions. Now the live path enqueues one `extract` job per durable message and returns; the worker drains `jobs` (Postgres, `FOR UPDATE SKIP LOCKED`). Three job types run today: `extract` (memory extraction per message), `journal-write` (first-person companion journal after a reply), and `pair-analysis` (holistic relationship reads — see Profiles). A fourth, `proactive-fire`, survives as an inert no-op for legacy rows.

- **Fairness:** jobs are per-guild serial (`maxPerGuild = 1`) — pipeline/event ordering is preserved — inside a global in-flight cap of 8.
- **Claims lease** the row (`attempts+1`, `run_after = now()+10min`) so a row is never double-claimed; completion deletes it, failure reschedules with exponential backoff, and a crashed worker's job becomes claimable again when the lease expires. `attempts ≥ 5` dead-letters (row kept for inspection, never claimed); the final failure fires `jobs.dead_letter`. `FatalJobError` dead-letters immediately for permanent failure (unknown `type`, malformed payload) instead of burning retries. Re-drive dead letters with `scripts/requeue-dead-jobs.mjs` (`GUILD_ID` optional).
- **Wake:** `pg_notify('jobs', …)` on enqueue + `LISTEN` in the worker; a 3s poll is the resilient baseline so a missed notification costs one poll.
- **Sweep integration:** the 15-min missed-signal sweep keeps its `triageBatch` role but enqueues durable verdicts into the same queue (marking `queued`) rather than extracting inline — one extraction path, one set of semantics. Each pass first runs `repairQueuedMarks`, which reconciles marks against job rows: extraction-marked messages with a live job canonicalize to `queued` (deduping the enqueue-succeeded/mark-write-failed window), `queued` whose only job is dead-lettered goes `dead` (terminal for the sweep, still reachable by `/profile-build`, overwritten by `extracted` on a successful requeue), and `queued` with no job at all resets to `durable`. `listUninspectedMessages` reads `durable`/`regex` marks at any age — the 2h window only bounds *untriaged* messages — so an orphaned mark always re-enqueues.
- **Worker handler** (`extract-job.ts`, deps injected for testability): alias-learn → per-image `describeImage` → `extractMemories` → consent-gated `persistExtraction` → terminal `extracted` triage mark → `runContestCheck` → `pipeline.process`. A guild that went dormant between enqueue and claim drops the job (`jobs.dropped_dormant`).

### Per-guild LLM budget

`brains.ts` wraps every constructed `OpenAI` client in `meteredClient` (`budget.ts`) — the Phase-1 `LlmClient` seam, so BYOK, env-fallback, and guarded-fetch paths all meter identically. Each `responses.create`/`chat.completions.create` first runs `chargeLlmCall` — an atomic `INSERT … ON CONFLICT` on `guild_usage (guild_id, day)` gated by `llm_calls < llm_daily_cap`. At/over cap → `BudgetExceeded`: the worker reschedules the job to next UTC midnight **without** burning an attempt; the reply path posts a one-per-channel-per-day notice instead of going silent. `cap = 0` blocks every call; `/server limits` sets the cap; `/server status` shows today's usage.

**Revenue-aware fleet cap (`src/fleet-cap.ts`).** The `hosted:global` breaker isn't static: `effective = HOSTED_DAILY_LLM_CAP + min(bonus, FLEET_CAP_MAX_BONUS)` where `bonus` counts active `web_profiles.plan='premium'` subs × conservative daily revenue ÷ estimated cost-per-call × safety factor — premium conversions literally buy the next thousand free turns during a viral spike, while usage alone never raises the cap. One provider (`getEffective`, 60s cache, single-flight refresh) feeds all consumers — the atomic hard cap, the `HOSTED_PRESSURE_SHED` free-lane shed, the hosted safety screen, and the `hosted:background` share — so the numbers can't drift. A UTC-day ratchet lets the cap grow intraday but holds drops until midnight (the counter's own day boundary), and every failure path decays to the static base — `HOSTED_DAILY_LLM_CAP=0` still freezes the fleet outright. `/ops stats` shows the breakdown (`fleet.cap_adjusted`/`fleet.cap_recompute_error` are the counters).

### Ignored and quiet channels

`server_settings.ignored_channels` (`/server ignore`, `/server unignore`, listed in `/server settings`) makes a channel fully invisible: `handleMessage` returns before `recordMessage`/`brainFor`/member writes, and the sweep filters archived rows from ignored channels.

`server_settings.quiet_channels` (`/server quiet`, `/server unquiet`, v46) is the softer tier: companions can't reply there (the final reply gate in `handleMessage` checks it) and companion system cards — the "Awaken / Summon" notice and summon/dismiss announcements — are suppressed, but archiving, extraction, and member writes keep running. Both lists match a thread's `parentId`, so a listed channel's threads follow it (and a thread can be listed directly). Combined with `/server companions-pause` (guild-wide `reply_enabled=0` while memory runs) and `/server pause` (both flags), admins get a graduated dial: quiet per channel → companions-pause server-wide → pause (everything off) → ignored (invisible).

A second, structural exclusion sits one level up: **marketplace listing threads** (`isMarketplaceThread` — a thread whose parent is `MARKETPLACE_CHANNEL_ID`) return from `handleMessage` *after* house automod but *before* event construction, so comments are moderated but never archived, extracted, answered, or greeted — they're public discourse on the listing card, not memory material. Unlike ignored channels this can't be configured away, and it applies to every guild message in those threads including replies to the card itself.

### Cross-guild isolation

`isolation.test.ts` is the dedicated proof: every store read path and every command surface is invoked as guild A against a seeded guild B and must return A's rows only (or a refusal) — including `jobs`/`guild_usage`/`guild_keys` and `purgeGuild` scoping.

## No proactive speaking

The Characterly bot is pure plumbing — it **never speaks unprompted** and only summoned companions reply, always triggered by a human message. An earlier proactive-answers feature was removed: any surviving `proactive-fire` job rows are drained as a no-op by the worker, the `PROACTIVE*` env vars are no longer parsed, and `server_settings.proactive_enabled` (v13) is an inert column nothing reads.

---

## Consent model

Derived data about a person — `person_*` memories, relationship observations, attributes, profiles, dossiers — is **opt-in**. Effective consent is `members.opted_in=1 AND members.opted_out=0`; `/opt-out` clears `opted_in` and always wins. Server lore (`subject_id='server'`), events, the member registry (names/counts — infrastructure, not profile data), and the raw message archive (retention-bounded) are consent-exempt.

- **Write path** — `persist-extraction.ts` is the single gate, shared by the live path, the nightly sweep, and `runProfileBuild`. Person memories persist only for consenting subjects (`unknown`/`server` exempt — unknowns are inert until resolved). Relationship observations use **subject-consent**: they persist when at least one real party opted in — the gate protects the people the claim is *about*; the assertor is stored (`author_id`) so their own opt-out erases claims they authored.
- **Read path** — `relevantMemories`, `searchMemories`, `pairwiseContext`, `getProfile(s)`, `buildProfiles`, `lookup_person`, and subject-scoped `search_memories` all filter or refuse non-consenting subjects, so a straggler row from before the purge stays invisible everywhere.
- **Self-service** — `/profile-build` (24h cooldown) opts the caller in, scans their archive corpus (`messagesAboutSubject`: authored + name-references + replies-to-them), verifies their candidates, recomputes edges, and runs a scoped `buildProfiles`. `/opt-in` consents without the scan.
- **Purge** — `scripts/purge-nonopted.mjs` (`PURGE_CONFIRM=1`) hard-deletes the pre-consent derived corpus for all non-consenting subjects; `buildProfiles` also deletes straggler profiles on sight.
- **The bot opts itself in** (per guild, at maintenance) so the room's claims about it remain memorable — the reply persona frames them as community claims, not self-truth.

## User-first LLM keys (BYOK) & Server Plumbing

Every LLM call resolves through `createBrainResolver` (`src/brains.ts`). In Characterly, **API keys belong to users** (`dm:<userId>` rows in `guild_keys`, AES-256-GCM encrypted via `KEY_ENCRYPTION_SECRET`), while the bot in a Discord server is the shared plumbing:

1. **In 1:1 DMs (`dm:<userId>`):** Resolves the user's personal key (`dm:<userId>`) → falls back to the operator's `GROQ_API_KEY` → `null` (which prompts the user with the **Connect Your Personal AI Key** onboarding card).
2. **When a Companion Speaks in a Server (`brainForUser(chosen.ownerUserId, guildId)`):** Uses the speaking companion owner's personal key (`dm:<ownerUserId>`), metered against that guild's daily cap.
3. **Background Server Plumbing (`brainFor(guildId)` for extraction, events, and pair-analysis):** Resolves via any active summoned companion owner's personal key in that server (`getGuildOwnerIds`), falling back to the operator's `GROQ_API_KEY` (when `REQUIRE_GUILD_KEYS=0`). Server admins never need to configure a server API key.
4. **Automatic Provider & Model Detection (`detectProviderFromKey`):** When a user pastes a key via `/companion key`, `/setup`, or the onboarding **Paste API Key** button and leaves `Base URL` blank, Characterly automatically configures the provider endpoint and default model (`gsk_...` → Groq `openai/gpt-oss-120b`, `sk-or-...` → OpenRouter `openai/gpt-oss-120b`, `sk-...` → OpenAI `gpt-4o-mini`, `xai-...` → xAI `grok-3-mini`).

## Guild lifecycle — consent posture

New guilds start **dormant**: `server_settings` defaults are `memory_enabled=0, reply_enabled=0` (v16), so `handleMessage` returns before archiving and nothing is recorded. On every `GuildCreate`, `announceIfNeeded` (`guild-lifecycle.ts`) posts the Characterly disclosure card to the system channel and stamps `server_settings.announced_at` **only after a successful send**. The card includes three buttons:
- **Enable Characterly (Admins)** (`server:enable`, requires `Manage Server`) — unpauses the server in one click (`setPaused(guildId, false)`), with no server API key required.
- **Awaken Your Companion** (`onboard:start`) — starts DM companion onboarding for members (or summons their already-awakened companion into the server).
- **Remove Characterly (Admins)** (`server:decline`, requires `Manage Server`) — a two-step opt-out. The first click replies **ephemerally** with a *Yes — remove and delete everything* / *Cancel* pair (the shared card stays put, so a stray click can't wipe an established guild and a confirm state can't strand the other buttons). On `server:declineconfirm` the card is edited to "leaving — every row deleted", `guild.leave()` runs, and then `pauseGuildClaims` + `store.purgeGuild` run **directly** — `GuildDelete` normally delivers the same purge, but the event is at-most-once and the purge is idempotent, so a dropped gateway event can't leave the privacy promise unkept. If `leave()` throws (or a second admin's confirm lands after the first), an ephemeral fallback tells the admin to kick manually — the kick fires `GuildDelete`, which purges anyway.

On `GuildDelete`, `handleGuildDelete` runs `store.purgeGuild` — every guild-scoped row in one FK-ordered transaction. `guild.unavailable` (a Discord outage, not a kick) is explicitly never a purge trigger, and post-purge straggler writes are swept by the periodic `guildsNotIn` orphan check.

---

## Data flow — `/profile-build` (self-service archive scan)

`/profile-build` (`profile-build.ts`) is the only history-replay path — an earlier admin-triggered bulk ingest (`/server-build`, `npm run ingest`) was removed. A member runs it on themselves (24h cooldown, one at a time): it opts them in, pulls their already-archived corpus within the retention window (`messagesAboutSubject`: authored + name-references + replies-to-them, capped at 1000), runs the standard consent-gated extraction/persist, sincerity-verifies their candidates, recomputes relationship edges, and runs a scoped `buildProfiles`. It never calls the Discord API — it only reads rows the live archive already stored — and it can only ever populate the caller's own derived data; other members still require their own opt-in.

---

## Profiles

`ProfileStore.buildProfiles()` runs during daily maintenance and scoped to one member via `/profile-build`. Eligibility requires consent (`opted_in=1 AND opted_out=0`) — non-consenting members are skipped and any straggler profile is deleted on sight. Profiles have three tiers, built in order:

1. **Attributes (source of truth)** — `src/attributes.ts` owns the structured facet set (`profile_attributes` table: eight fields — singular `pronouns`/`timezone`/`location`/`occupation`/`birthday`, multi-valued `trait`/`interest`/`skill`). Deterministic regexes over `person_fact`/`person_preference` memory content run every pass (pure, idempotent — doubles as the lazy backfill for memories that predate the feature). `Brain.extractAttributes()` then proposes fuzzy facets (`trait`/`interest`/`skill`) gated on `source_hash`, a fingerprint of *semantic* inputs only — memories, candidates, patterns, edges, events — so raw activity churn costs zero LLM. Proposals must cite input memory ids with at least one confirmed citation (uncited and candidate-only proposals are dropped); the current attribute vocabulary is passed in so the model reuses labels verbatim or emits an explicit `replaces`. `applyProposals()` upsert-diffs each proposal: exact match on `(field, value_norm)` revives or no-ops → polarity-gated trigram fold at ≥0.6 (0.4–0.6 logs `attr_near_miss`) → insert. Singular fields supersede sibling live rows via `superseded_by`; status is otherwise derived from cited-memory statuses. Memory lifecycle mutations cascade immediately — `forget` strips citations, `supersede`/`mergeDuplicate` transfer them — so a forgotten fact never lingers as a rendered facet.
2. **Card (prose)** — `Brain.synthesizeProfile()` renders `bio` + `role_in_server` from the *post-diff* active attribute set plus stats/patterns/edges/events, gated on `attr_hash` (attribute rows + that same context). Unchanged render inputs → no re-render; facets assemble deterministically (`traits`/`interests` from active rows, `notableRelationships` from verified edges).
3. **Dossier** — unchanged: independently-hashed narrative sections (below).

Only `active` attributes render; `contested` surfaces in `/server triage`. `/profile` shows each facet's memory citations, `/memory export` includes the attribute rows, and members without consent (`opted_in=0` or `opted_out=1`) have their profile *and* attribute rows deleted on the next pass. Profiles surface via `/profile` (self or admin) and are injected into `brain.reply()` for the author, @-mentioned users, and members referenced by name — where each person carries their active attributes with confidence buckets (`formatReplyProfile`), so weak facets render hedged rather than as flat assertions.

Members with ≥3 active memories or ≥50 messages additionally get a **dossier** — a set of independently-built sections stored under `facets_json.dossier.sections`, each rebuilt only when its own input hash changes:

- `voice` — writing style analyzed from a 60-message raw sample plus deterministic stats (avg length, caps/emoji/question rates)
- `life_situation`, `beliefs` — sourced item lists citing memory IDs (`source_ids`)
- `temperament`, `reputation` — prose + sourced items; reputation uses only third-party claims (evidence author ≠ subject)
- `relationship_map` — per-person dynamics from merged edges (A→B + B→A collapsed at read time), bidirectional observation reasons, and the deterministic interaction graph (mention + name-ref frequency from `interactionPairs`)
- `timeline` — deterministic event list, no LLM

Degenerate LLM output (repeated glyphs, JSON blobs) is detected per section and never overwrites existing data. Dossiers surface via `/dossier` (self or admin); `reply()` only ever injects the card.

Candidate memories pass a **sincerity verification** gate before they can activate: `Brain.verifyMemoriesBatch` re-judges each promotable candidate against its stored source message, the author's known names, and the preceding chat lines (literal / joke / unclear / misattributed). Verified literal self-reports promote to `active`; jokes are re-classified `sarcasm_or_joke` (confidence → 0.10, never promotable); `misattributed` verdicts — pasted/quoted text describing someone other than the poster — are forgotten outright; third-party literals stay candidate pending corroboration. Verification runs in `applyRetention()` and at the end of ingest before profile builds.

Relationship assertions pass the analogous gate: `Brain.verifyRelationshipsBatch` labels each observation `literal` / `joke` / `misattributed` / `unclear` against its source message and preceding lines, and `recomputeEdges()` rebuilds the derived `relationships` table from `literal` verdicts alone — an unverified, pasted, or ironic claim ("we're basically married") never surfaces in `/profile`, dossier inputs, or the reply prompt. New edges therefore materialize at the next maintenance pass rather than at record time. Each observation also stores its `author_id` (the assertor — v19, backfilled from the source message), which lets `/opt-out` erase a member's authored claims about others and lets the derived-data prune drop rows that can never surface: `NULL`-verdict observations whose source message is gone, and non-literal verdicts aged past 90 days.

**Edge aggregation (v20)** — `recomputeEdges(guildId, interactions)` is the sole writer. Edge `summary` is the *modal* nature over the five most recent literals (`MODE() WITHIN GROUP`) so a contradictory flip doesn't rewrite history on one observation. `valence` is a *weighted* average over the same window — observations authored by an edge party count double a third party's, so a pair's own words outweigh gossip. `observation_count` stays all-time; `party_count` tracks self-report depth (zero → "all secondhand" at render). `trend` marks `warming`/`cooling` when the recent-5 weighted average diverges ±0.2 from the *prior* window — an all-time baseline would include the recent rows themselves, damping the delta and making n≤5 incapable of trending. The deterministic interaction graph (`interactionPairs`: 90d mention/name-ref frequency, honoring the ignored-channel boundary and excluding non-companion bot authors/targets) stamps `behavioral_count` onto claimed edges — and pairs with ≥5 contacts in 90d but zero claims materialize as **inferred edges** (`inferred=1`, no summary/valence): rows that render strictly as contact frequency, never a relationship claim. Extraction reuses the guild's established nature labels (`relationshipNatureVocab`) so "close friends" doesn't fragment into synonym churn.

**Pair-analysis jobs** (`pair-analysis-job.ts`, job type `pair-analysis`) close the gap extraction can't see: relationships nobody verbalizes. Maintenance enqueues the top interaction pairs (≥10 contacts in 90d, **both** parties consented — stricter than the either-party write rule because the job reads both people's exchanges — ≥7d since last analysis, and only when new interaction happened since). The handler fetches the pair's exchange window (`pairExchanges`, ≤40 messages where one addressed the other) and `Brain.analyzePairWindow` judges the dynamic from the pattern, not single messages — returning *directional* natures (`a_to_b_nature`/`b_to_a_nature`, so "A mentors B" never mints "B mentors A"; symmetric reads repeat the label). Confident reads land as directed `source='pair_window'` observations with `verdict='literal'` — the window read IS the verification, so no second pass is needed — while unconfident runs write `unclear` markers whose timestamps throttle retries. The newest exchange id lands as `pw:<id>` provenance so an extracted observation on the same message can't collide the row out; queued-but-unrun jobs are checked (`hasPendingPairAnalysis`) so a slow pass can't enqueue a duplicate. `author_id` stays NULL: the system is the assertor, and party-side opt-out deletes them like any observation. BudgetExceeded parks to the UTC-day reset like extract.

On the reply path, `MemoryStore.pairwiseContext()` and `EventStore.sharedEvents()` assemble the *current-message* pairs — both directed edges, recent attributed observation reasons, per-pair claims (active memories about one side authored by the other), and events both attended — injected as a `Relationships:` prompt section separate from the flat `People:` profiles, so the model can reference shared history rather than reciting isolated facts. Direction is preserved (`subject_id` is the asserting side) and claims render attributed ("Bob claimed about Alice"), never as facts. `formatPairContext` renders depth honestly — observation counts become confidence tiers ("claimed once" / "well-established"), gossip-only edges carry "all secondhand", stale edges say "not recently observed", and inferred edges render only as contact frequency. The author's pair with the bot itself is included when the author consented (the bot's auto-opt-in can't guard its own edge) — the reply model sees its own dynamic with each member.

Dedup runs at two tiers. The **hot path** uses the pg_trgm fallback in `saveMemory()` — a `similarity(content)` lookup scoped to `(guild, subject, kind)` reinforces one row instead of splitting rephrased extractions (with a polarity check so contradictions can't ride the merge). The **maintenance tier** is semantic: `Brain.dedupMemoriesBatch` scans each member's memory list nightly and proposes `duplicate`/`contradicts` groups — catching pairs with no lexical overlap that trigrams can't see ("allergic to peanuts" / "can't eat nuts"). `applyDedupGroups` merges confirmed groups deterministically: the canonical row keeps its status (merging never promotes), non-colliding evidence moves over (rows sharing a `message_id` stay on the loser — `memory_history` references them via FK), losers become `superseded` with an audit link. `contradicts` verdicts are logged to history only — truth arbitration stays with the contest/supersede machinery.

**Paste/quote attribution.** Extraction instructs the model not to attribute quoted, pasted, or persona text to the poster ("I am \<other person\>", reposted bios, copied bot output) — it should attribute to the named person via `subjectName` or skip it. A deterministic guard (`detectSelfNaming`) flags "I am \<Capitalized Name\>" patterns where the name isn't one of the author's `known_names` and annotates the extraction input.

**Contest detection.** Messages that address the bot and carry denial/correction cues (`contestCue`) are checked by `Brain.detectContest` (in `src/contest.ts`) against the author's stored memories. `contests` relations attach `contradict` evidence (status → `contested`, confidence frozen, `resolveContested` arbitrates via `net_score`); `confirms` attach `support` evidence that can resolve a contested memory back to `active`. Runs live in `MessageCreate` and as a sweep at the end of ingest.

---

## Memory lifecycle states

```
              extractMemories()
                    │
                    ▼
              [ candidate ]
              /            \
  enough confirmations      stays uncertain
  + promotable evidence       │
  type + confidence ≥ 0.70   │
              │             7 days old → [ quarantined ]
              ▼
           [ active ]
          /         \
  contradiction    /memory correct
  arrives                command
     │               │
     ▼               ▼
 [ contested ]   [ superseded ]
     │
  resolves (net_score ≥ 0.50
  && confidence ≥ 0.70 &&
  newest evidence = support)
     │
     ▼
  [ active ]  ←─── (or stays contested)

  Any status → [ forgotten ]  (/memory forget command)
  Active, low confidence, 90 days old → [ quarantined ]
```

**Confidence is frozen** while a memory is `contested`. Only `net_score` changes during that period, keeping the two signals independent.

### Promotable evidence types

Only `explicit_fact`, `clear_preference`, and `correction` can promote a candidate to `active`. `sarcasm_or_joke`, `reported_by_other`, and `uncertain_inference` are permanently barred from promotion regardless of evidence volume or confidence.

---

## Event tiers

```
  EventPipeline.process()
        │
        ▼
  [ candidate ]  ── open window collects messages & memories ──►
        │
   daily maintainEvents()
        │
        ├── significance ≥ 0.60 → [ event ]   (surfaced to users via /event)
        └── significance < 0.35 → discarded   (kept in DB, never surfaced)
             (0.35–0.60 stays candidate, re-scored on next run)
```

Back-references to a closed candidate can retroactively promote it to `event` tier if its `reference_count` reaches 2.

---

## Web accounts & the website (v26–v42)

`web/` is an Astro app on Cloudflare Workers (`@astrojs/cloudflare`; `npm run deploy` → `astro build` + `wrangler deploy`; live at `SITE_URL`). Pages: `index` (SSR landing with the live shelf strip), `characters/` (SSR catalog + per-listing cards), prerendered legal pages (`terms`/`privacy`/`security`/`safety`, rendered at build time from the repo's `.md` files via `src/lib/legal.ts`), guides, `account` (sign in / sign up / magic link / password recovery), and `dashboard` (the account hub below). `src/worker.ts` runs ahead of every request: canonical-host redirect, CSP/security headers, `/discord/events`, `/avatar`(+`/gc`), `/track`, and Analytics Engine beacons. The site talks directly to Supabase with the publishable key in `web/src/lib/config.ts`; there is no app server — the Data API is the backend, and row-level security is the access control. (Legacy Vite site: `archive/website/`.)

- **The dashboard plates:** profile, Discord link/unlink (with the v38 Discord username/avatar snapshot), **Tokens** (balance/plan/`credit_ledger`), **Companion settings** (c2c toggle, low-token alerts, BYOK status), **character-card import** (client-side parse → `import_companion_card` rpc), **Billing** (Premium + token packs via the `create-checkout`/`stripe-webhook` edge functions), password change, and guarded delete-account.
- **Session teardown is hardened against wedged auth calls** — `signOut()` clears `sb-*` keys synchronously with a `scope:"local"` SDK signOut; `deleteAccount()` reads the stored token directly and POSTs the rpc (see website.md).

- **Auth (Supabase Auth):** email+password (signup stores `display_name` in user metadata), magic link, password recovery, and Discord OAuth (`signInWithOAuth`/`linkIdentity` — always offered; the old `DISCORD_OAUTH_ENABLED` flag was retired in the rebuild). Each new `auth.users` row gets a `public.web_profiles` row via the `internal.handle_new_user` trigger — the "real life user" counterpart to the Discord-side `members` registry.
- **RLS posture (v23/v26):** every `public` table has RLS enabled with zero Data-API policies — deny-all for `anon`/`authenticated`; the bot's postgres role bypasses RLS. `web_profiles` is the deliberate exception: own-row select/insert policies, and `UPDATE` granted only on `(display_name, updated_at)` so users can never write `discord_user_id` or `stripe_customer_id` on their own row (a forged snowflake would steal another user's perks).
- **Discord ↔ web linking, two paths:**
  - **OAuth:** signing up/in with Discord, or `linkIdentity` from the dashboard, writes a `discord` row in `auth.identities`; the `on_identity_sync` trigger (`internal.sync_discord_identity`) copies `provider_id` into `web_profiles.discord_user_id` — covering OAuth signup, manual link, auto-merged identities, and unlink/deletion (which NULLs it back out). A duplicate Discord link raises `discord_already_linked`. v38: the trigger also stamps a display snapshot (`discord_username`/`discord_avatar_url`) from `identity_data`.
  - **`/link` code flow (Discord-first users):** the bot's `/link` command mints a one-time `XXXX-XXXX` code (`link_codes`, 10-min expiry, one active code per Discord user) carrying a snapshot of the caller's Discord profile (v38: `discord_username`/`discord_avatar_url` — the bot already knows the user, no extra fetch). Entering it on the dashboard calls the security-definer `claim_link_code` rpc, which validates and stamps `discord_user_id` plus the snapshot — the only non-trigger path that can write the columns. Code-links claimed before v38 have a NULL snapshot; the bot heals them at boot (one `users.fetch` per gap → `syncDiscordIdentity`).
- **Unlink rules:** the dashboard offers unlink only when the user has ≥2 identities (Supabase refuses to orphan the last one); password users get a set-password escape hatch. Account deletion goes through the `delete_own_account` rpc (`DELETE FROM auth.users`, cascades to `web_profiles`).

All Supabase-facing DDL (auth triggers, `web_profiles`, `claim_link_code`) is conditional on the `auth` schema existing, so plain-Postgres test and self-hosted databases skip it unchanged — `link_codes` itself lives outside that gate so the bot can mint codes anywhere.

---

## Key design principles

1. **LLM provides language interpretation only.** `brain.ts` extracts `subjectId`, `kind`, `content`, `reason`, `evidenceType`, and `effect`. All numeric values (confidence, importance, explicitness, significance) are calculated deterministically by `confidence.ts` and `event-significance.ts`.

2. **Evidence is deduplicated by `(memory_id, message_id)`.** Replaying the same message cannot inflate confidence. Cross-author repetition creates separate evidence rows and legitimately builds confidence.

3. **Transactions everywhere.** `saveMemory()` and `createEvent()` both use Postgres transactions so partial state is impossible.

4. **Conservative speaking.** The bot observes silently and replies only to direct mentions by default (`SPEAK_THRESHOLD=0.70`). The recency penalty never suppresses a direct mention.

---

## Further reading

- [`docs/schema.md`](schema.md) — all tables, columns, and indexes
- [`docs/event-pipeline.md`](event-pipeline.md) — event detection in detail
- [`docs/configuration.md`](configuration.md) — all environment variables
- [`docs/security-model.md`](security-model.md) — trust boundaries and the defenses on each
- [`docs/development.md`](development.md) — scripts, tests, website, deployment, and contributor guide
- [`web/README.md`](../web/README.md) — site quick-start
