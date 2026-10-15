# Characterly

A Discord companion & social-memory platform where every person awakens **one permanent personal AI companion** in 1:1 DMs and brings them into shared Discord servers.

In servers, the **Characterly** bot is invisible plumbing and a system announcer — it never speaks in character. Instead, it routes conversations across summoned companions, posts their replies under their own name and avatar via Discord webhooks, bridges private DM subtext with group server activity, and maintains an inspectable, consent-gated memory and relationship graph.

---

## Core Concepts

### 1. One Permanent Companion Per Account (Awakened in 1:1 DMs)
- Users DM Characterly (or click **Awaken Your Companion** in any Characterly server) to shape their companion through a short slice-of-life conversation, 1-click starter archetypes (**Chaotic Co-Conspirator**, **Dry & Deadpan**, **Ride-or-Die**, **Surprise Me**), or a direct form modal.
- Every turn renders a live **Companion Draft** card showing `Name`, `Bond / Dynamic`, `Voice & Vibe`, `Core Traits`, `Backstory`, and `Avatar` (attach any image in DMs to give them a face).
- **Permanent Lock:** Once a user clicks **Awaken & Lock In**, their companion's identity is **permanently bound to their account** (`1 companion per account`).

### 2. User-First Personal AI Keys (Auto-Detected Providers)
- Each user connects their own API key (`dm:<userId>`) via the onboarding **Paste API Key** button or `/companion action:key`.
- Users only paste their API key and **leave the Base URL field blank** — Characterly automatically detects the provider and default model from the key prefix:
  - `gsk_...` → **Groq** (`openai/gpt-oss-120b`)
  - `sk-or-...` → **OpenRouter** (`openai/gpt-oss-120b`)
  - `sk-...` → **OpenAI** (`gpt-4o-mini`)
  - `xai-...` → **xAI** (`grok-3-mini`)
- Keys are validated live against `/models` and encrypted at rest with **AES-256-GCM** (`KEY_ENCRYPTION_SECRET`). A user's personal key powers their companion in DMs and in every server they summon them into.

### 3. Characterly as Server Plumbing (1-Click Server Setup)
- When added to a Discord server, Characterly posts a welcome card and starts **dormant**.
- A server admin clicks **Enable Characterly (Admins)** on the card (or runs `/memory-resume`) — **no server API key is required**.
- Members summon their companions with `/companion action:summon` (or 1-click **Summon to `<Server>`** buttons in DMs). Characterly announces **`System · <Name> joined the chat`** when a companion arrives and **`System · <Name> left the chat`** when dismissed.

### 4. Multi-Companion Scene Routing & Webhook Identity
- **Webhook Disguise (`src/webhooks.ts`):** Summoned companions speak through a cached channel webhook (`Characterly Companions`) disguised with their own name and avatar (including inside threads). If `Manage Webhooks` permission is missing, Characterly posts a system permission notice rather than roleplaying as the companion.
- **Scene Router (`src/scene-router.ts`):** Coordinates multiple summoned companions in the same channel:
  - **Direct Address (`+0.85`):** Saying a companion's name (`detectWakeWord`) or replying to that companion's webhook message routes the turn to that companion and suppresses unaddressed companions.
  - **Per-Companion Engagement (`+0.70`):** Each companion tracks its own active conversation participants while sharing the channel floor for share-of-voice pacing.
  - **Owner Affinity (`+0.15`):** Companions prioritize turns where their owner is engaged or asking a question.
  - **Bounded Companion-to-Companion Banter:** Companions can address and reply to each other up to `MAX_COMPANION_CHAIN_DEPTH` (default `2` hops per human message) before hard-stopping.

### 5. Cross-Context Consciousness (DM ↔ Server Bridge)
- **DM → Server (Vault Rule):** When speaking in a server, a companion receives high-confidence memories and facets from its private 1:1 DMs with its owner (`gatherOwnerSubtextForServer`) under a strict **VAULT RULE** — used only for subtext, loyalty, and inside jokes, never disclosed to other server members.
- **Server → DM:** When chatting in 1:1 DMs, a companion receives a digest of recent events, relationship edges, and activity from the servers where it is summoned (`gatherServerDigestForDm`) so it can debrief and gossip with its owner.

### 6. Provenance-Backed Memory, Relationships & Events
- **Deterministic Confidence & Sincerity Verification:** Candidate memories and relationship observations are verified against source context (`literal` / `joke` / `misattributed` / `unclear`) before activating; numeric confidence is computed deterministically (`src/confidence.ts`).
- **Provenance Facets, Profiles & Dossiers:** Structured `profile_attributes` cite the exact `memory_ids` that justify them — forgetting or superseding a memory cascades immediately to any facet citing it.
- **Behavioral Relationship Intelligence:** Combines verified single-message claims with the 90-day interaction graph and holistic `pair-analysis` exchange-window reads (`warming` / `cooling` trends).

### 7. First-Person Companion Journal
- After each reply, a deferred `journal-write` job lets the companion write 0–2 **first-person** entries ("Alice and I roasted her tea take") into `companion_journal` — its own episodic memory, origin-tagged to the scope where it happened.
- Entries recall only in their origin scope (guild entries in that server, DM entries in the DM) and via the Vault subtext lane; consent-gated like extraction, covered by `/opt-out` and `/memory-export`, and dormant-but-retained when a companion is dismissed.

### 8. Web Accounts, Website & Discord Linking
- A Vite site (`website/`) hosts the landing page plus **Characterly accounts** (Supabase Auth: email/password, magic link, Discord OAuth) and an account dashboard — deployed as Cloudflare Workers Static Assets.
- `web_profiles` links the "real-life" account to the Discord user via `discord_user_id` — written only by the `auth.identities` sync trigger (OAuth/`linkIdentity`) or the `claim_link_code` rpc behind `/link`; users can never write it directly. `stripe_customer_id` is reserved for the future billing phase.

### 9. Hosted Lane & Tokens (Credits)

- **Two lanes:** BYOK stays the power-user lane — a personal key means unlimited chat, no account needed. Without a key, companions run on the **hosted lane** (the operator's env model) which requires a **linked Characterly account** (`/link`) and spends **tokens**.
- **Payer-per-turn:** a human's turn costs 2 tokens (their message + the companion reply — 1 refunded if no reply lands); companion↔companion hops bill the replying companion's owner 1, gated by their c2c dashboard toggle. Nobody can burn someone else's tokens.
- **Lazy refills:** free accounts refill to 30 tokens each UTC day; premium to 150/day — applied atomically inside the spend transaction (`credit_ledger` audits every change, including Stripe pack purchases). No scheduler.
- **Fleet breaker:** `HOSTED_DAILY_LLM_CAP` bounds total hosted calls/day independent of credits; BYOK calls never count.
- **Free-tier throttle:** extraction + journaling for free hosted users coalesce into hourly batches (freshness, not quality); premium and BYOK run live.
- Dashboard plates: **Tokens** (balance/plan/ledger) and **Companion settings** (c2c, low-token alerts, BYOK status).

---

## Commands

All command replies are ephemeral (private to the invoker) unless noted; companion arrivals and departures post public system notices.

### Companions & Members

| Command | What it does |
|---------|--------------|
| `/companion action:card` | View your (or another member's) awakened companion card and relationships |
| `/companion action:list` | See all companions currently active in this server and how to address them |
| `/companion action:summon` | Summon your personal companion into this Discord server |
| `/companion action:dismiss` | Dismiss your companion from this server |
| `/companion action:key` | Connect or rotate your personal AI API key (leave Base URL blank for auto-detection) |
| `/companion action:status` | Check your personal API key status, active servers, and today's DM usage |
| `/companion action:avatar` | Update your companion's avatar image URL |
| `/memory` | List your active memories (8/page; `page:`, `search:`, `memory_id:` to inspect provenance, `candidates:true` for unconfirmed, `server:true` for lore) |
| `/memory-confirm` | Promote one of your own candidate memories to active |
| `/memory-export` | Download every memory + evidence held about you |
| `/forget` | Forget one of your memories (confirmation button required) |
| `/correct` | Replace a memory — supersedes genuinely contradictory active ones |
| `/privacy` | See what Characterly stores in this server, the retention window, and your consent state |
| `/opt-out` | Forget everything about you, delete your profile, revoke consent |
| `/opt-in` | Consent to memories + a profile about you (live activity only) |
| `/profile-build` | Opt in **and** scan your archive history to build your structured profile now (once per 24h) |
| `/profile` | View your profile card (another member's: admins only) |
| `/dossier` | Deep dossier — voice, life situation, temperament, beliefs, relationship map, reputation, timeline |
| `/event` | Inspect the server event a memory is attached to |
| `/link` | Get a one-time code to link this Discord account to your Characterly web account |

### Server Administrators (`Manage Server`)

| Command | What it does |
|---------|--------------|
| `/companion action:kick user:@member` | Remove a member's companion from this server |
| `/memory-pause` / `/memory-resume` | Pause or enable Characterly in this server — archiving included |
| `/ignore-channel` / `/unignore-channel` | Make a channel invisible to Characterly — no archiving, no replies, no member writes, no `/server-build` scans |
| `/memory-settings` | Show effective server settings (including ignored channels and daily LLM cap) |
| `/limits` | Set this server's daily LLM-call cap (0 = block all calls; usage resets each UTC day) |
| `/status` | Uptime, operational counters, active summoned companions, queue health, today's LLM usage vs cap |
| `/memory about:@member` | Inspect another member's memories |
| `/memory stats:true` | Server memory counts |
| `/memory-triage` | Newest memories across all members + contested attributes |
| `/memory-purge` | Purge raw archived messages older than N days |
| `/server-build` | Backfill a channel's history (requires explicit confirm click; archives + lore + events for everyone, derived person data for opted-in members only) |

---

## Privacy & Security Model

- **Dormant by default in servers.** New servers observe nothing until an admin clicks **Enable Characterly** or runs `/memory-resume`. Removing Characterly from a server deletes every row it stored there.
- **Derived data is opt-in.** Person memories, relationship observations, attributes, profiles, and dossiers form only for members who consent (`/opt-in`, `/profile-build`, or summoning a companion).
- **The Vault Rule (DM → Server isolation).** Private 1:1 DM memories are never exposed to other server members or lookup tools; they inform only the companion's internal subtext with its owner.
- **Encrypted keys & SSRF guards.** Personal API keys are encrypted at rest with AES-256-GCM (`src/secrets.ts`), scrubbed from logs, and custom endpoints are protected against DNS-rebinding SSRF at socket connect time (`src/brains.ts`, `src/tools.ts`).
- **Deletes propagate & retention is bounded.** Deleting a Discord message removes its archive row and scrubs verbatim quotes on any evidence it produced; raw messages age out on `RAW_MESSAGE_RETENTION_DAYS`.

Legal: [Privacy Policy](PRIVACY.md) · [Terms of Service](TERMS.md) · [Security](SECURITY.md)

---

## Quick Start

**Prerequisites:** Node.js 20+, a Postgres database (e.g. a free [Supabase](https://supabase.com) project — use the Session pooler URL on port 5432), and a Discord bot token with **Message Content Intent** and **Manage Webhooks** permission.

```bash
git clone https://github.com/Alby2007/characterly.git
cd characterly
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, KEY_ENCRYPTION_SECRET, DATABASE_URL (and optional GROQ_API_KEY)
npm run dev            # or: npm start
```

Migrations (`v1`–`v28`) apply automatically on first boot — no manual SQL.

### Key Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `DISCORD_TOKEN` | *(required)* | Discord bot token |
| `DATABASE_URL` | *(required)* | Postgres connection string |
| `KEY_ENCRYPTION_SECRET` | *(recommended)* | AES-256-GCM master passphrase for encrypting user API keys |
| `GROQ_API_KEY` | *(optional)* | Operator fallback key when `REQUIRE_GUILD_KEYS=0` |
| `REQUIRE_GUILD_KEYS` | `0` | `1` requires users to connect their own personal API key (`dm:<userId>`) |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Default base model |
| `DM_LLM_DAILY_CAP` | `250` | Per-user daily LLM call cap in 1:1 DMs |
| `MAX_COMPANION_CHAIN_DEPTH` | `2` | Max consecutive companion-to-companion turns per human message |
| `SPEAK_THRESHOLD` | `0.70` | Minimum `selectCompanionForTurn()` score to speak |
| `RAW_MESSAGE_RETENTION_DAYS` | `30` | Raw message archive retention window |

Full reference: [docs/configuration.md](docs/configuration.md)

---

## Development

```bash
npm run check   # typecheck (tsc --noEmit, strict)
npm test        # node:test suite — DB tests use TEST_DATABASE_URL
```

Docs: [Architecture](docs/architecture.md) · [Database Schema](docs/schema.md) · [Event Pipeline](docs/event-pipeline.md) · [Configuration](docs/configuration.md) · [Website & Accounts](docs/website.md) · [Operations](docs/operations.md) · [Developer Guide](docs/development.md)

### Layout

```
src/
  index.ts          # Discord client, 1:1 DM onboarding & chat loop, server message loop, maintenance
  scene-router.ts   # Multi-companion scene router & companion-to-companion chain-depth guard
  webhooks.ts       # Per-companion Discord channel webhook sender & thread routing
  cross-context.ts  # Asymmetric DM <-> Server consciousness bridges (Vault Rule + server digest)
  brains.ts         # User-first Brain resolver & API key prefix provider/model auto-detection
  brain.ts          # All LLM calls (onboarding, extraction, verification, replies)
  database.ts       # MemoryStore — companions, webhooks, memories, evidence, relationships
  commands.ts       # Slash commands, onboarding cards/modals, interaction handlers
  attributes.ts / profiles.ts / dossier.ts / events.ts / jobs.ts / journal-job.ts / ...
website/            # Vite site — landing + accounts/dashboard, deployed to Cloudflare Workers
scripts/            # Ops utilities (sweeps, backfills, verification, dead-letter requeue)
```
