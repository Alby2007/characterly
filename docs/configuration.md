# Configuration Reference

Characterly is configured through environment variables validated at startup by `src/config.ts` using [zod](https://github.com/colinhacks/zod). Copy `.env.example` to `.env` and fill in the required values before starting the bot.

---

## Environment variables

### Required

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Your Discord bot token. Obtain from the [Discord Developer Portal](https://discord.com/developers/applications) under Bot → Token. |
| `DATABASE_URL` | Postgres connection string. Use the **Session pooler** URL (port 5432) from your Supabase project: **Settings → Database → Connection string → Session mode**. Example: `postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres` |
| `GROQ_API_KEY` | Operator default LLM API key (optional when `REQUIRE_GUILD_KEYS=1` and `KEY_ENCRYPTION_SECRET` is set so users connect their own personal keys). |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Default model name passed to Groq (or custom provider). |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Default OpenAI-compatible base URL when not auto-detected from a user's key prefix. |
| `KEY_ENCRYPTION_SECRET` | unset | Master passphrase encrypting user API keys at rest (AES-256-GCM, SHA-256-derived). Required for `/companion action:key`, `/setup`, and the onboarding **Paste API Key** modal. When users leave Base URL blank, Characterly auto-detects Groq (`gsk_...`), OpenRouter (`sk-or-...`), OpenAI (`sk-...`), or xAI (`xai-...`). Any string; rotating it orphans existing `guild_keys` rows (recovery = re-run `/companion action:key` or `/setup`). |
| `REQUIRE_GUILD_KEYS` | `0` | Hosted BYOK mode: `1` disables the operator `GROQ_API_KEY` fallback so companions and servers run strictly on user-supplied personal keys (`dm:<userId>`) — a keyless guild goes fully dormant (no archive, no replies, no LLM spend). Self-hosters leave this off. Note this is a *key* gate, orthogonal to the consent posture: every guild also starts dormant (`memory_enabled=0`) until an admin runs `/memory-resume`. |
| `DM_LLM_DAILY_CAP` | `250` | Per-user daily LLM call cap for 1:1 DMs (`dm:<userId>` scope, resets at UTC midnight). |
| `FREE_DAILY_CREDITS` | `30` | Free-plan hosted accounts refill to this balance each UTC day (hosted lane only). Applied lazily inside `spendCredits` — no scheduler. A refill tops up to the floor; a balance already above it keeps its headroom (grants don't stack). |
| `PREMIUM_DAILY_CREDITS` | `150` | Daily refill floor for premium accounts — high enough to feel unlimited (≈75 turns/day) while remaining metered so an abusive account stays bounded. |
| `HOSTED_DAILY_LLM_CAP` | `20000` | Fleet-wide circuit breaker: max hosted (env-key) LLM calls per UTC day across all users. BYOK calls never count. When tripped, hosted chats get the capacity notice until UTC midnight. |
| `LOW_CREDIT_ALERT` | `5` | Balance threshold for the once-per-day low-token DM (skippable via the dashboard Companion settings toggle). |
| `LINK_PROMPT_COOLDOWN_MS` | `14400000` | Minimum interval between "link your account" prompts to the same unlinked user (default 4h). |
| `MAX_COMPANION_CHAIN_DEPTH` | `2` | Maximum consecutive companion-to-companion replies per human message in a server channel (0–5). Hard-stops runaway bot loops. |
| `REPLY_BURST` | `4` | Per-user/actor token-bucket burst capacity before reply throttling kicks in (refunded automatically if a reply is unsent). |
| `REPLY_REFILL_MS` | `30000` | Milliseconds to refill 1 token in the per-user reply throttle bucket. |
| `GUILD_ID` | (empty) | If set, restricts the bot to a single Discord server. **Recommended during development** to avoid accidental activity in other servers. Leave empty to enable all servers the bot has joined. |
| `SITE_URL` | `https://characterly-website.albertjemmettwaite.workers.dev` | Public URL of the Characterly website — `/link` replies point users at `${SITE_URL}/dashboard` to claim their link code. |
| `AVATAR_UPLOAD_SECRET` | (off) | Shared secret for the website worker's `PUT /avatar` lane — every `avatar_url` set-point re-hosts the source image into a public Supabase Storage bucket (`companion-avatars`, lazily created) so avatars outlive Discord CDN signatures and link rot. Must match the `AVATAR_UPLOAD_SECRET` secret on the website worker. Unset disables the lane — set-points keep the source URL. |
| `SPEAK_THRESHOLD` | `0.70` | Minimum `selectCompanionForTurn()` / `brain.decide()` score required to send a reply. Range 0–1. |
| `RAW_MESSAGE_RETENTION_DAYS` | `30` | How many days of raw Discord messages to keep in the `messages` table. Messages older than this are deleted by the daily maintenance job. Evidence quotes in `memory_evidence` are **not** affected by this purge. Range 1–365. |
| `CANDIDATE_CONFIDENCE_THRESHOLD` | `0.70` | Minimum confidence required to auto-promote a candidate memory to active status (subject to evidence type gates). Range 0–1. |
| `REPLY_MODEL` | `GROQ_MODEL` | Model used for Discord replies, across all reply paths. Any Groq model id, or `groq/compound*` for Groq's agentic system with built-in web tools. Reasoning models (gpt-oss, qwen3) get `reasoning_effort=low` automatically to cut latency and flatten the register. |
| `REPLY_TOOLS` | (off) | `1` attaches free local tools to replies — `web_search`/`visit_url` plus internal lookups (`lookup_person`, `lookup_relationship`, `search_memories`, `lookup_event`) — on a direct mention or when a message matches tool cues. |
| `VERIFY_MODEL` | `PROFILE_MODEL` → `GROQ_MODEL` | Model for memory/relationship verification and dedup passes. |
| `PROFILE_MODEL` | `GROQ_MODEL` | Model for profile card synthesis. |
| `DOSSIER_MODEL` | `GROQ_MODEL` | Model for dossier section synthesis. |
| `CONTEST_MODEL` | `VERIFY_MODEL` → `INGEST_MODEL` → `GROQ_MODEL` | Model for contest/denial detection. |
| `INGEST_MODEL` | `GROQ_MODEL` | Model for batched extraction passes (`/profile-build`) — also the `VERIFY_MODEL` fallback for sincerity checks. |
| `INGEST_TRIAGE_MODEL` | `GROQ_MODEL` | Model for the message-durability triage pass. |
| `VISION_MODEL` | (off) | Vision-capable model for image understanding (e.g. `gemini-2.5-flash` on Gemini's free tier). **Unset disables image handling entirely** — there is no fallback to `GROQ_MODEL`, since a text-only model could silently drop the image block and store a hallucinated description. When set, image attachments (`image/*` except GIFs, ≤`IMAGE_MAX_BYTES`, ≤3/message) are described once and the text rides the normal extraction/reply pipelines; URLs and bytes are never persisted. |
| `VISION_API_KEY` | `GROQ_API_KEY` | API key for the vision provider — set only when `VISION_MODEL` lives off-Groq (e.g. a Gemini AI Studio key). |
| `VISION_BASE_URL` | `GROQ_BASE_URL` | OpenAI-compatible endpoint for the vision provider (e.g. `https://generativelanguage.googleapis.com/v1beta/openai/` for Gemini). |
| `IMAGE_MAX_BYTES` | `4000000` | Per-image size cap for `VISION_MODEL` processing; larger attachments are skipped. Keep at or under the provider's per-image limit. |
| `WAKE_WORD` | `1` | Saying the bot's name — its username, display name, server nickname, or a summoned companion's name — counts as addressing it (same as an @-mention: reply trigger, always-inspect, tools armed). Word-boundary matched, names under 3 chars ignored. `0` disables if casual name-drops get noisy. |
| `ENGAGEMENT` | `1` | Conversational engagement: once someone addresses the bot (mention, reply-to-bot, or wake word), a per-channel conversation opens and their follow-up messages get a mid-tier reply score (+0.70) for `ENGAGEMENT_TTL_MS` without re-mentioning — the bot stays in the thread. Participants leave three ways: TTL expiry (refreshes only on addressed messages, so drift decays out), explicit dismissals ("shut up &lt;name&gt;", "we're done" — deterministic override), or the reply model's `end_conversation` signal. `0` reverts to address-only replies. |
| `REPLY_EXIT` | `1` | Honor the reply model's `end_conversation` flag — when the model reads a wrap-up ("ok cool thanks that's all") the human leaves the conversation, so wrap-ups the dismissal regex can't parse don't keep the +0.70 bonus alive for the full TTL. `0` ignores the flag; regex dismissal keeps working regardless. |
| `ENGAGEMENT_TTL_MS` | `120000` | How long a participant stays "in conversation" after their last addressed message. Range 10s–1h. Longer = chattier mid-flow but slower to drop out. |
| `PROACTIVE`, `PROACTIVE_DELAY_MS`, `PROACTIVE_DAILY_CAP`, `PROACTIVE_RESPONSE_WINDOW_MS`, `PROACTIVE_BACKOFF_MS` | — | **Legacy no-ops.** The proactive-speaking feature was removed (the bot is pure plumbing and never speaks unprompted). These variables are still parsed so old `.env` files don't fail validation, but nothing reads them — setting any of them has no effect. Same for `server_settings.proactive_enabled`. |

### Companion marketplace

The marketplace lives in a forum channel on the hub server. **`MARKETPLACE_CHANNEL_ID` unset disables publishing entirely** (`/companion action:publish`/`create` refuse; adoption and chat are unaffected). Behavior detail in [marketplace.md](marketplace.md).

| Variable | Default | Description |
|---|---|---|
| `MARKETPLACE_CHANNEL_ID` | (off) | Forum channel where the bot posts listing threads. Needs **Create Public Threads** (+ **Manage Threads** for clean archiving). |
| `MARKETPLACE_MOD_CHANNEL_ID` | unset | Text channel pinged on listing + comment reports, with mod action buttons. |
| `MARKETPLACE_MOD_ROLE_IDS` | (ManageGuild) | Comma-separated role ids allowed to act on report pings — the marketplace-mod lane exists because mods may not hold Member/ManageGuild. |
| `FREE_ADOPTION_SLOTS` | `1` | Active adoptions per free account (Premium uncapped; enforced atomically in `adoptListing`). |
| `FREE_LISTING_SLOTS` | `2` | Live listings per free creator account (Premium uncapped; enforced inside the write transactions). |
| `ADOPTION_COOLDOWN_MS` | `43200000` | Re-adopt lockout after a drop (min 1h, default 12h); the freed slot is usable by *other* listings immediately. |
| `MARKETPLACE_REPORT_FLAG_THRESHOLD` | `3` | Reports that auto-flag a listing (moderation hold — only a mod action clears it). |
| `MARKET_PUBLISH_DAILY_CAP` | `5` | New listings per creator per UTC day (republishes/relists don't consume it). |
| `MARKET_REPORT_DAILY_CAP` | `20` | Reports per user per day — shared across listing and comment reports. |
| `MARKET_ADOPT_DAILY_CAP` | `20` | Adoptions per user per day (anti-farming — inflates `add_count` otherwise). |
| `MARKET_NEW_TAG_DAYS` | `7` | How long a fresh listing keeps the curated `New` badge. |
| `MARKET_TOP_RATING_AVG` | `4.5` | Minimum average for the `Top Rated` badge. |
| `MARKET_TOP_RATING_MIN` | `5` | Minimum rating count for `Top Rated`. |
| `MARKET_TRENDING_COUNT` | `5` | Adoptions inside the window that earn `Trending`. |
| `MARKET_TRENDING_WINDOW_H` | `72` | `Trending` window in hours. |
| `SAFETY_MODEL` | `GROQ_MODEL` | Classifier model for listing publish/edit screens and adopted-companion reply screens. |

### Semantic recall (embeddings)

Opt-in hybrid retrieval — unset `EMBED_BASE_URL` disables the semantic legs cleanly and the lexical legs run as before. Any OpenAI-compatible `/embeddings` endpoint works (local Ollama, OpenAI, vLLM). Setup notes in [operations.md](operations.md).

| Variable | Default | Description |
|---|---|---|
| `EMBED_BASE_URL` | (off) | OpenAI-compatible endpoint root (e.g. `http://127.0.0.1:11434/v1` for Ollama). |
| `EMBED_MODEL` | `all-minilm` | Embedding model id. **Different dimensionality requires clearing stale vectors** (`UPDATE memories SET embedding=NULL; UPDATE companion_journal SET embedding=NULL;`). |
| `EMBED_API_KEY` | `ollama` | Endpoint API key (any string for keyless local servers). |
| `EMBED_DIMS` | `384` | Expected vector dimensionality — enforced in code since the columns are un-dimensioned `vector`. |
| `EMBED_MAX_DISTANCE` | `0.55` | Cosine-distance ceiling for semantic hits — raise toward 0.65 if recall rarely fires. |

### House ops (private layer — our community server + this host)

Entirely opt-in: **`HOUSE_GUILD_ID` unset disables everything** below — no extra intents, no listeners, no watchdog. Setting it requests the privileged **Server Members Intent** — toggle that in the dev portal *before* deploying or login fails. Details in `docs/operations.md`.

| Variable | Default | Description |
|---|---|---|
| `HOUSE_GUILD_ID` | (off) | Our community server id — gates member ops, automod, `/ops` |
| `HOUSE_MEMBER_ROLE_ID` | — | "Verified member" role — granted by the `house:verify` button after a linked-account check; auto-revoked by the link sweep when the account is unlinked |
| `HOUSE_WELCOME_CHANNEL_ID` | — | Welcome posts land here |
| `HOUSE_RULES_CHANNEL_ID` | — | Pointed at from welcome messages |
| `HOUSE_VERIFY_CHANNEL_ID` | — | Lobby gate channel — a persistent verify card is posted here on boot if missing |
| `HOUSE_ANNOUNCE_CHANNEL_ID` | — | `/ops announce` target |
| `HOUSE_ADOPTEES_CHANNEL_ID` | name-match `adoptees` | Parent channel for adopted-companion private threads (v54). Name fallback binds a channel created before the env existed |
| `HOUSE_INVITE_URL` | `SITE_URL` | Public server invite shown to non-member adopters who need to join before their adoptee thread can open |
| `OPS_CHANNEL_ID` | `MARKETPLACE_MOD_CHANNEL_ID` | Ops alerts + host breach/recovery notices |
| `OPS_USER_IDS` | — | Comma-separated user ids allowed to run `/ops` (controls the host — person-level, tighter than ManageGuild) |
| `OPS_REPO_DIR` | `~/characterly` | Repo checkout on the host for `/ops deploy` |
| `AUTOMOD_BURST_COUNT` / `_WINDOW_MS` | `6` / `8000` | Messages-per-window that trips burst spam (delete + 5m timeout) |
| `AUTOMOD_MENTION_MAX` | `8` | Mentions over this = mass mention (delete + alert) |
| `AUTOMOD_NEW_ACCOUNT_DAYS` | `7` | Accounts younger than this can't post external links |
| `AUTOMOD_RAID_JOINS` | `8` | Joins in 60s that trip the raid alert |
| `AUTOMOD_RAID_KICK` | off | `1` auto-kicks joins while the raid window is hot |
| `HOST_HEAP_PCT` / `HOST_DISK_PCT` / `HOST_LAG_MS` | `90` / `85` / `1000` | Watchdog breach thresholds (alert once, recover notice) |
| `HOST_HEALTH_INTERVAL_MS` | `300000` | Watchdog tick |

---

## Discord bot setup

1. Create an application at [discord.com/developers/applications](https://discord.com/developers/applications).
2. Add a Bot user. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
3. Under **OAuth2 → URL Generator**, select scopes `bot` and `applications.commands`, then grant the following permissions:
   - Read Messages / View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - **Manage Webhooks** *(used by `sendAsCompanion` to post server replies with each summoned companion's custom name and avatar)*
4. Use the generated URL to invite Characterly to your server. Once joined, click **Enable Characterly (Admins)** on the welcome card (or run `/memory-resume`) — no server API key is required.

---

## Runtime settings (per-guild overrides)

Administrators can adjust per-server behaviour at runtime without restarting the bot. These settings are stored in the `server_settings` table and override the default values from environment variables for that specific server.

| Command | Effect |
|---------|--------|
| `/memory-pause` | Sets `memory_enabled=0` and `reply_enabled=0`. The bot stops observing and replying immediately. |
| `/memory-resume` | Sets both back to 1. |
| `/companions-pause` | Sets only `reply_enabled=0` — companions go silent server-wide while archiving and memory extraction keep running. |
| `/companions-resume` | Sets `reply_enabled=1` without touching `memory_enabled`. |
| `/memory-settings` | Shows current values of `memory_enabled`, `reply_enabled`, `raw_retention_days`, `llm_daily_cap`, and the `ignored_channels`/`quiet_channels` lists. |
| `/limits daily_cap:N` | Sets `llm_daily_cap` — the per-guild LLM-call budget per UTC day (default 1000, range 0–100000). `0` blocks every LLM call for the guild; usage resets at UTC midnight. Deferrable work (extract jobs) reschedules to the next day rather than failing; a reply-path call at cap posts a one-per-channel-per-day notice. |
| `/ignore-channel channel:#c` | Adds a channel to `ignored_channels` — fully invisible to the bot: no archiving, no replies, no member writes. |
| `/unignore-channel channel:#c` | Removes a channel from `ignored_channels`. |
| `/quiet-channel [channel:#c]` | Adds a channel to `quiet_channels` (defaults to the current channel) — companions can't reply or post system cards there, but archiving and memory extraction continue. Threads inherit their parent channel's listing and can also be listed directly. |
| `/unquiet-channel [channel:#c]` | Removes a channel from `quiet_channels`. |
| `/memory-purge older_than_days:N` | Manually deletes raw messages older than N days for this server (regardless of the global retention setting). |
| `/status` | Shows bot uptime, in-process operational counters, and today's LLM usage vs the guild's cap. |
| `/memory-triage` | Shows the 15 most recently stored memories across all members, with status, kind, and subject. |

### How runtime settings interact with env variables

- `SPEAK_THRESHOLD` and `CANDIDATE_CONFIDENCE_THRESHOLD` are process-level constants. They apply to all guilds and can only be changed by restarting with different env values.
- `RAW_MESSAGE_RETENTION_DAYS` sets the initial default for new guilds. Once a guild row exists in `server_settings`, the `raw_retention_days` column is the authoritative value for that guild.
- `reply_enabled` is checked before `SPEAK_THRESHOLD`. A paused server will never receive a reply even if the score exceeds the threshold.
- `llm_daily_cap` bounds a guild's total LLM spend per UTC day — every call through the guild's resolved `Brain` (extraction, triage, replies, verification, tools) charges `guild_usage` atomically before executing. `0` means "no LLM calls at all"; archived messages still record, they just queue for extraction until the cap resets.

### Job queue (fixed parameters)

Deferrable cognition (`extract`, `journal-write`, and `pair-analysis` jobs — memory extraction, contest checks, event-pipeline processing, companion journaling, relationship reads) runs on a Postgres-backed queue rather than inside the live message handler. The constants are compile-time in `src/jobs.ts`, not env-configurable: global in-flight cap **8**, per-guild concurrency **1** (preserves event ordering), 3-second poll with `LISTEN`/`NOTIFY` wake hints, 10-minute claim lease, exponential backoff, dead-letter at **5** attempts. Jobs that hit `BudgetExceeded` reschedule to the next UTC midnight without consuming an attempt.

---

## Test-only variable

| Variable | Default | Description |
|----------|---------|-------------|
| `TEST_DATABASE_URL` | unset | Postgres connection string for the test suite. Read directly by `src/test-helpers.ts` (not `config.ts`) and honored **only inside the test runner** — it can never redirect a real bot. Required for the DB-backed tests; see [development.md](development.md#test-suite). |

---

## Website configuration

The site in `website/` has no env file — its client config is compile-time in `website/src/config.js`:

| Key | Purpose |
|-----|---------|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | The same Supabase project as the bot (`tfukkoektmsrolykliop`). The publishable key is public by design — access is enforced by RLS, not key secrecy. |
| `LINKS` | Single source of truth for outbound links (bot invite, Discord invite, repo, legal pages). |
| `DISCORD_OAUTH_ENABLED` | Shows the Discord sign-in/link buttons once the Discord provider is configured in Supabase Auth (client id + secret from the bot's Discord application, callback URL registered in the Discord developer portal). Currently `true`. |

Server-side, `SITE_URL` (above) tells the bot where to send users claiming a `/link` code.
