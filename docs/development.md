# Developer Guide

Everything you need to work on Characterly locally.

---

## Prerequisites

- **Node.js** 20+ (the project uses ES modules and `node:test`)
- A **Discord bot token** — see [configuration.md](configuration.md) for setup
- A **Groq API key** (or OpenRouter / OpenAI / xAI key) — free at [console.groq.com](https://console.groq.com)
- A **Postgres database** — a free [Supabase](https://supabase.com) project works. Use the Session pooler connection string (port 5432).
- `npm` (bundled with Node)

---

## First-time setup

```bash
git clone https://github.com/Alby2007/characterly.git
cd characterly
npm install
cp .env.example .env
# Edit .env and fill in DISCORD_TOKEN, GROQ_API_KEY, KEY_ENCRYPTION_SECRET, and DATABASE_URL
# Set GUILD_ID to your test server's ID while developing
```

On first run the bot connects to Postgres, creates all tables, and applies migrations automatically — no manual SQL required.

---

## npm scripts

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start with live reload via `tsx watch`. Restart on every file save. |
| `npm start` | Start once (no reload). Use for production. |
| `npm run ingest` | Bulk-ingest historical messages from a Discord channel. Set `INGEST_CHANNEL=channel-name` before running. Safe to re-run — already-processed messages are skipped. |
| `npm run check` | TypeScript type-check only (`tsc --noEmit`). No output = pass. |
| `npm test` | Run the full test suite using Node's built-in test runner. |

---

## scripts/ utilities

One-shot operational scripts. They import `src/*.ts` sources directly, so run them through `tsx` — `npx tsx scripts/<name>.mjs` — with the usual env (`DATABASE_URL`, `GUILD_ID`, `GROQ_API_KEY` where needed).

| Script | Purpose |
|--------|---------|
| `maintain.mjs` | Runs the nightly maintenance pass on demand (memory lifecycle + event maintenance). |
| `build-profiles.mjs` | Backfills the member registry from the archive, then runs `buildProfiles` — useful after ingest or schema changes. |
| `verify-memories.mjs` | Batch-runs sincerity verification over pending candidate memories (`VERIFY_MODEL`). |
| `contest-sweep.mjs` | Retroactively applies bot-addressed denials/corrections as contest evidence on archived messages. |
| `backfill-relationships.mjs` | One-off: re-extracts relationship observations over the archive, verifies, recomputes edges, rebuilds profiles. |
| `requeue-dead-jobs.mjs` | Re-drives dead-lettered `jobs` rows back into the claimable set (`GUILD_ID` optional). |
| `purge-nonopted.mjs` | Hard-deletes all derived data (memories, evidence, attributes, profiles, relationships) for non-consenting members. Requires `PURGE_CONFIRM=1` — irreversible. See README privacy section. |
| `_lib.mjs` | Shared helpers imported by the other scripts (not run directly). |
| `dev/` | Quarantined one-offs and diagnostics (`check-db`, `list-models`, `audit-filter`) — kept for reference, not maintained. |

---

## Test suite

Tests live alongside source files as `*.test.ts`. Run them all with `npm test`.

| File | Coverage |
|------|---------|
| `confidence.test.ts` | Determinism of all confidence formulas; initial values by evidence type; update behaviour for all four effects |
| `evidence.test.ts` | Evidence deduplication by `(memory_id, message_id)`; replay protection; cross-author corroboration still builds confidence; transaction atomicity |
| `migrations.test.ts` | Migration apply and rollback for every version; idempotency; schema column presence checks |
| `reliability.test.ts` | Pre-filter (`shouldInspectForMemory`); candidate promotion gates (evidence type allowlist); lifecycle transitions; age-weighted quarantine |
| `adversarial.test.ts` | Sarcasm and `uncertain_inference` volume accumulation cannot promote; `reported_by_other` promotion gate; confidence manipulation via contradiction timing; contested state confidence freeze |
| `event.test.ts` | Heuristic scoring signals (reply chain, participant overlap, keyword overlap, recency, back-reference); `calculateSignificance` tier assignment; retroactive promotion threshold |
| `brain.test.ts` | `decide()` scoring: direct mention overrides recency penalty; recency penalty applies to non-mention messages; unmentioned chatter stays below threshold. Extraction/contest/verification prompt parsing via an injected `LlmClient` stub |
| `attributes.test.ts` | `normalizeValue`/`attributeHash` canonicalisation; `deriveAttributeStatus` precedence (contested > active > candidate > quarantined); `applyProposals` upsert-diff: exact revive, trgm fold, singular supersession, provenance cascades |
| `commands.test.ts` | Slash-command authorization matrix: non-admin vs admin cross-member views, opt-out/forget ownership, confirm-button userId binding, admin-gated commands, opt-in consent flag, `/profile-build` + `/server-build` |
| `dedup.test.ts` | Trigram near-duplicate merge: same-claim phrasing reinforces instead of duplicating; distinct content stays separate; episodes never fuzzy-merge |
| `entity-resolution.test.ts` | `resolveSubject` mention/name/self-resolution; `buildAliasMap` from `known_names`; `findMentionedUsers` matching rules |
| `perception.test.ts` | Durable-signal pre-filter patterns; bot-addressed bypass; `detectNamingRequest`/`detectSelfNaming` extraction and stopword rejection |
| `profiles.test.ts` | `recordMessage` member upsert/dedup/`reply_to_id`; `buildProfiles` consent + eligibility gates, attribute pipeline, dossier build |
| `persist-extraction.test.ts` | Consent-gated extraction writes: person memories only for opted-in subjects, server lore exempt, relationship subject-consent, opt-out beats opt-in |
| `companion.test.ts` | 1:1 DM conversational onboarding, bare-greeting guard, permanent 1-companion-per-account lock, personal API key onboarding with provider auto-detection, 1-click `server:enable`, `selectCompanionForTurn` multi-companion routing, and DM ↔ Server cross-context bridges (`gatherOwnerSubtextForServer` + `gatherServerDigestForDm`) |
| `brains.test.ts` | `createBrainResolver` caching, key rotation, undecryptable row handling, `detectProviderFromKey` prefix auto-detection, `brainForUser`, and server plumbing resolution via `getGuildOwnerIds` |
| `conversation.test.ts` | `ConversationTracker` participant enrollment, TTL expiry, share-of-voice window, and `bystanderVoices` 1:1 vs shared-floor detection |
| `speech-gate.test.ts` | `evaluateSpeechTurn` transcript replay, dismissal overrides, room-directed suppression, and `ReplyThrottle` burst/refund behavior |
| `tools.test.ts` | `isSafeUrl` SSRF guards; `stripHtml`/`parseDdgLite` parsing; `executeTool` error strings never throw |
| `jobs.test.ts` | Queue claim protocol: `run_after` ordering, `SKIP LOCKED` no-double-claim, at-cap guild exclusion, dead-letter at max attempts, BudgetExceeded midnight reschedule without burning attempts |
| `extract-job.test.ts` | Worker drain: queued message → `extracted` with consented memories; consent drops; dormant guild drops; failed job stays claimable; vision client metering |
| `journal.test.ts` | `Brain.writeJournal` prompt/parsing; origin-scoped recall; write-time consent filter; opt-out recall filtering + `forgetJournalAbout` |
| `pair-analysis-job.test.ts` | Directed literal observation writes; unconfident → `unclear` marker only; both-party consent requirement; thin-window/dormant drops |
| `pairwise.test.ts` | `pairwiseContext` edge direction, literal-only observations, cross-authored claims, opt-out erasure |
| `lookup-tools.test.ts` | Internal reply tools: friendly error strings, consent refusals, active-attribute-only rendering |
| `isolation.test.ts` | Cross-guild isolation proof: every store read and command surface returns only the querying guild's rows (incl. `jobs`/`guild_usage`/`guild_keys`, `purgeGuild` scoping) |
| `guild-lifecycle.test.ts` | Dormant defaults on fresh guilds, `announced_at` idempotency, `purgeGuild` FK-ordered wipe |
| `link-code.test.ts` | `/link` code minting: `XXXX-XXXX` unambiguous alphabet, re-issue replaces, expiry sweeps, per-user uniqueness |
| `secrets.test.ts` | AES-256-GCM roundtrip, random IV uniqueness, wrong-key and tamper rejection |
| `vision.test.ts` | `qualifyingImages` type/byte/count gates; `formatImageContext` framing; `describeImage` data-URI + strict json_schema |

### Adding a test

Tests use Node's built-in `node:test` and `node:assert/strict`. All database tests run against a real Postgres instance — set `TEST_DATABASE_URL` in your `.env` before running:

```bash
# Fastest option: local Postgres via Docker
docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm test

# Or point at a dedicated Supabase test project (separate from production)
TEST_DATABASE_URL=postgresql://postgres:[pw]@db.[ref].supabase.co:5432/postgres npm test
```

Each test creates a fresh `sql` connection via `makeTestSql()` from `src/test-helpers.ts`, runs migrations, truncates all data, then closes the connection on teardown. Tests do not share state.

**Run files serially.** `npm test` passes `--test-concurrency=1` because all DB tests share one database — running `tsx --test src/*.test.ts` directly races the migrations/truncates and fails en masse. Pointing `TEST_DATABASE_URL` at a hosted Supabase project can also flake under load; a local Docker Postgres is the reliable choice.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";

test("description of what you are testing", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // arrange, act, assert
  } finally { await sql.end(); }
});
```

`brain.test.ts`, `confidence.test.ts`, `attributes.test.ts`, `perception.test.ts`, and `tools.test.ts` run without a database.

---

## Adding a migration

1. Open `src/migrations.ts`.
2. Add a new object to the `migrations` array with the next version number:

   ```ts
   {
     version: 6,
     name: "descriptive_snake_case_name",
     up: async (sql: Sql) => {
       // addColumn() is idempotent — safe to call even if the column exists
       await addColumn(sql, "memories", "new_column TEXT");
       // or: await sql`CREATE TABLE IF NOT EXISTS ...`
     },
     down: async (sql: Sql) => {
       // Postgres supports DROP COLUMN:
       await sql`ALTER TABLE memories DROP COLUMN IF EXISTS new_column`;
       // For new tables: await sql`DROP TABLE IF EXISTS ...`
     },
   }
   ```

3. The migration is applied automatically on the next startup.
4. Add a test in `src/migrations.test.ts` verifying the column/table exists after applying and is gone/nulled after rollback.

**Naming convention:** use a prefix that identifies the phase or feature (`phase_1a_`, `v02_`, etc.) followed by a description of what was added.

---

## Database access

The database lives in Supabase Postgres (or any Postgres configured via `DATABASE_URL`). Use the Supabase dashboard's **Table Editor** or **SQL Editor** to inspect data. From `psql`:

```bash
psql "$DATABASE_URL"

-- Check migration state
SELECT * FROM schema_migrations ORDER BY version;

-- Count memories by status
SELECT status, COUNT(*) FROM memories GROUP BY status;

-- Schema overview
\dt
```

The bot writes no local files — all state lives in Postgres. (`data/` is gitignored and may hold local dev leftovers; nothing in the runtime touches it.)

---

## Debugging tips

### Groq rate limits (ingest)

`server-ingest.ts` paces LLM calls with `BATCH_DELAY_MS = 3000` between extraction batches, `EVENT_DELAY_MS = 3000` between pipeline calls, and `TRIAGE_DELAY_MS = 1500` between triage calls. If you hit 429 errors:
- The script reads the `x-ratelimit-reset-tokens` header and waits accordingly (shared `withRetry` in `src/retry.ts`).
- Up to 6 retries are attempted with exponential backoff.
- You can increase the `*_DELAY_MS` constants at the top of `server-ingest.ts` if your Groq tier has tighter limits.

### Bot not responding to direct mentions

1. Check that `GUILD_ID` is set correctly (or unset for all guilds).
2. Confirm **Message Content Intent** is enabled in the Discord Developer Portal under Bot → Privileged Gateway Intents.
3. Verify the bot has **Send Messages** and **Read Message History** permissions in the target channel.
4. Check `SPEAK_THRESHOLD` — it defaults to 0.70. A direct mention scores 0.90, so it should always exceed the threshold. If it still doesn't reply, check that `reply_enabled` is 1 in `server_settings` (use `/memory-settings`).

### Memory not being extracted

- The pre-filter in `perception.ts` is intentionally conservative. A message must be 12–2000 characters and match at least one durable-signal pattern. Short or casual messages are skipped.
- Check the `memory_enabled` setting for the guild (`/memory-settings`).
- Set `GUILD_ID` so you can confirm which server's messages are being processed.

### TypeScript errors

```bash
npm run check
```

All errors must be resolved before committing. The project uses `strict: true`.

---

## Project structure reference

```
characterly/
├── src/
│   ├── index.ts              # Entry point — Discord client, 1:1 DM onboarding/chat, server message loop, job worker, daily maintenance
│   ├── scene-router.ts       # Multi-companion scene router & chain-depth loop guard
│   ├── webhooks.ts           # Per-companion Discord webhook sender & thread routing
│   ├── cross-context.ts      # Asymmetric DM ↔ Server consciousness bridges
│   ├── conversation.ts       # Per-channel/per-companion conversation objects & share-of-voice pacing
│   ├── brains.ts             # User-first Brain resolver & API key prefix provider auto-detection
│   ├── brain.ts              # All LLM calls (onboarding, extraction, verification, journal, replies)
│   ├── budget.ts             # meteredClient — per-scope daily LLM budget charged via guild_usage
│   ├── secrets.ts            # AES-256-GCM key encryption, masking, live key validation
│   ├── config.ts             # Env validation (zod)
│   ├── types.ts              # Shared TypeScript types
│   ├── db.ts                 # Shared postgres.js connection singleton
│   ├── database.ts           # MemoryStore (Postgres: companions, journal, link codes, memories, edges)
│   ├── events.ts             # EventStore (Postgres)
│   ├── migrations.ts         # Versioned schema migrations (v1–v27)
│   ├── confidence.ts         # Deterministic confidence formulas
│   ├── perception.ts         # Pre-filter regex, wake words, dismissals, tool cues
│   ├── event-detection.ts    # EventPipeline — heuristic + LLM continuity
│   ├── event-significance.ts # Significance scoring formula
│   ├── entity-resolution.ts  # Display-name → user-ID resolution & alias map
│   ├── persist-extraction.ts # Single consent-gated write path for extraction
│   ├── extract-job.ts        # Worker handler for 'extract' jobs
│   ├── journal-job.ts        # Worker handler for 'journal-write' jobs
│   ├── pair-analysis-job.ts  # Worker handler for 'pair-analysis' jobs
│   ├── jobs.ts               # Postgres job queue (SKIP LOCKED, leases, dead-letter)
│   ├── contest.ts            # Bot-addressed denial/correction detection
│   ├── profiles.ts           # ProfileStore — cards + dossiers
│   ├── attributes.ts         # Structured provenance-backed profile facets
│   ├── dossier.ts            # Per-section dossier input gathering
│   ├── profile-build.ts      # /profile-build per-user scan
│   ├── server-ingest.ts      # Server-level historical build (ingest + /server-build)
│   ├── ingest.ts             # CLI wrapper for runServerIngest
│   ├── guild-lifecycle.ts    # Join disclosure card, 1-click enable, kick-purge
│   ├── commands.ts           # Slash commands, onboarding cards/modals, interaction handlers
│   ├── speech-gate.ts        # Standalone speak/silence evaluator for tests
│   ├── reply-throttle.ts     # Per-user reply token bucket
│   ├── reply-format.ts       # Shared prompt/tool output formatters
│   ├── tools.ts              # Reply tool dispatcher (web + internal lookups)
│   ├── lookup-tools.ts       # Read-only internal lookup tools
│   ├── vision.ts             # Image-attachment gate & description
│   ├── metrics.ts            # In-process operational counters (/status)
│   ├── retry.ts              # Shared LLM retry helper (rate-limit aware)
│   ├── test-helpers.ts       # Shared Postgres test utilities (TEST_DATABASE_URL)
│   └── *.test.ts             # 30 test files, co-located with source
├── website/
│   ├── index.html            # Landing page
│   ├── account.html          # Sign in / sign up / magic link / recovery
│   ├── dashboard.html        # Profile, Discord link card, password, account deletion
│   ├── src/                  # auth.js, dashboard.js, account.js, config.js, supabase.js, main.js, styles.css
│   ├── cloudflare.config.ts  # characterly-website Worker (static assets)
│   └── vite.config.js        # Multi-page inputs + @cloudflare/vite-plugin
├── .github/workflows/
│   └── test.yml              # CI: check + tests on Postgres service; gated deploy to Oracle
├── scripts/                  # Operational one-shots (see table above)
├── docs/
│   ├── architecture.md       # Module map, companions, journal, web accounts, data flow
│   ├── schema.md             # Database schema reference (through v27)
│   ├── event-pipeline.md     # Event detection explainer
│   ├── configuration.md      # Env var + website config reference
│   ├── development.md        # This file
│   └── phase-*.md            # Historical phase reports (point-in-time, Sep 2026)
├── .env.example              # Template for environment variables
├── package.json
└── tsconfig.json
```

---

## Website

The site is a standalone Vite multi-page app — it has its own `package.json` and node_modules:

```bash
cd website
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle → dist/
npm run deploy   # cf deploy → Cloudflare Workers static assets
```

`npm run deploy` uses the [cf CLI](https://developers.cloudflare.com/workers/ci-cd/) — `@cloudflare/vite-plugin` emits the Build Output Spec at build time and `cloudflare.config.ts` declares the `characterly-website` worker (assets-only, 404-page handling). First deploy requires `cf login` (or an API token). The publishable Supabase key in `src/config.js` is public by design — RLS enforces access. Discord OAuth must be configured in Supabase Auth (Discord provider client id/secret from the bot's Discord application, callback URL registered in the Discord developer portal) before `DISCORD_OAUTH_ENABLED` is flipped on.

---

## CI / CD

`.github/workflows/test.yml` runs on every push and PR:

1. **test** — `npm ci`, `npm run check` (tsc), then `npm test` against a Postgres 16 service (`TEST_DATABASE_URL` pointed at the service container).
2. **deploy** — only on green pushes to `main`, gated by `environment: production` (attach required reviewers in repo settings so a push alone can't ship). SSHes to the Oracle host and runs `cd ~/characterly && git pull --ff-only && npm ci && sudo systemctl restart characterly`. Required secrets: `ORACLE_SSH_KEY`, `ORACLE_HOST_KEY` (`ssh-keyscan` output — pinned host key, fails closed), `ORACLE_SSH_HOST` (`user@ip`).

The website deploys separately — `npm run deploy` inside `website/` — and is not part of CI.
