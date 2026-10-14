# Characterly

A Discord companion & community-memory platform where every person awakens **one permanent personal AI companion** in 1:1 DMs and summons them into shared Discord servers.

In servers, **Characterly** acts as the shared plumbing — routing conversations across multiple summoned companions, posting replies disguised with each companion's name and avatar via Discord webhooks, bridging private DM subtext with group server activity, and maintaining an inspectable, consent-gated social memory graph.

---

## How it works

1. **Connect Your Personal AI Key (1-Step Onboarding)** — Users paste their own API key (`gsk_...` Groq, `sk-or-...` OpenRouter, `sk-...` OpenAI, or `xai-...` xAI) via the onboarding button or `/companion action:key` and leave `Base URL` blank — Characterly auto-detects the provider and model and encrypts the key at rest (AES-256-GCM).
2. **Awaken Your Permanent Companion in 1:1 DMs** — Through a short slice-of-life conversation (or 1-click starter archetypes + live draft previews), each user shapes their companion's name, voice/vibe, traits, dynamic, and optional avatar image. **Each account gets one companion — once awakened, their character is permanently locked in.**
3. **1-Click Server Setup & Summoning** — A server admin invites Characterly and clicks **Enable Characterly** on the welcome card (or runs `/memory-resume`) — **no server API key is required**. Members summon their companions into the server with `/companion action:summon` (or 1-click summon buttons in DMs).
4. **Multi-Companion Scene Routing & Webhooks** — Summoned companions speak through channel webhooks using their own name and avatar (`src/webhooks.ts`). `selectCompanionForTurn` (`src/scene-router.ts`) routes turns by wake-word name match, webhook reply attribution, owner affinity (`+0.15`), and shared floor pacing, while allowing companion-to-companion banter capped at `MAX_COMPANION_CHAIN_DEPTH` (default 2).
5. **Cross-Context Consciousness (`src/cross-context.ts`)** —
   - **DM → Server (Vault Rule):** Companions bring their private DM bond with their owner into server hangouts strictly as subtext and inside jokes — never leaking private DM facts to other members.
   - **Server → DM:** In 1:1 DMs, companions know what happened in the servers they're summoned to (recent events, relationships, and activity) so they can gossip and debrief with their owner.
6. **Provenance-Backed Memory, Relationships & Events** — Deterministic confidence scoring, sincerity verification (`literal` / `joke` / `misattributed` / `unclear`), net-score conflict resolution, `profile_attributes` with memory citations, holistic `pair-analysis` relationship reads, and server event continuity.

---

## Commands

All replies are ephemeral (private to the invoker) unless noted.

### Companions & Members

| Command | What it does |
|---------|--------------|
| `/companion action:card` | View your (or another member's) awakened companion card and relationships |
| `/companion action:list` | See all companions currently active in this server and how to address them |
| `/companion action:summon` | Summon your personal companion into this Discord server |
| `/companion action:dismiss` | Dismiss your companion from this server |
| `/companion action:key` | Connect or rotate your personal AI API key (auto-detects Groq, OpenRouter, OpenAI, or xAI when Base URL is blank) |
| `/companion action:status` | Check your personal API key status, active servers, and today's DM usage |
| `/companion action:avatar` | Update your companion's avatar image URL |
| `/memory` | List your active memories (8/page; `page:`, `search:`, `memory_id:` to navigate/inspect, `candidates:true` for your unconfirmed queue, `server:true` for lore) |
| `/memory-confirm` | Promote one of your own candidate memories to active |
| `/memory-export` | Download every memory + evidence held about you |
| `/forget` | Forget one of your memories (confirmation button required) |
| `/correct` | Replace a memory — supersedes genuinely contradictory active ones |
| `/privacy` | See what Characterly stores in this server, the retention window, and your own consent state |
| `/opt-out` | Forget everything about you, delete your profile, revoke consent |
| `/opt-in` | Consent to memories + a profile about you (live activity only) |
| `/profile-build` | Opt in **and** scan your archive history to build your structured profile now (once per 24h) |
| `/profile` | View your profile card (another member's: admins only) |
| `/dossier` | Deep dossier — facets, relationships, opinions, style, timeline (another member's: admins only) |
| `/event` | Inspect the server event a memory is attached to |

### Administrators (`Manage Server`)

| Command | What it does |
|---------|--------------|
| `/companion action:kick user:@member` | Remove a member's companion from this server |
| `/memory about:@member` | Inspect another member's memories |
| `/memory stats:true` | Guild memory counts |
| `/memory-triage` | Newest memories across all members + contested attributes |
| `/memory-purge` | Purge raw archived messages older than N days |
| `/memory-pause` / `/memory-resume` | Pause or enable Characterly in this server — archiving included |
| `/memory-settings` | Show effective guild settings (including the ignored-channel list and daily LLM cap) |
| `/ignore-channel` / `/unignore-channel` | Exclude a channel entirely — no archiving, no replies, no member writes, no `/server-build` scans |
| `/limits` | Set this server's daily LLM-call cap (0 = block all calls; usage resets each UTC day) |
| `/status` | Uptime, error counters, active summoned companions, pipeline health, today's LLM usage vs cap |
| `/server-build` | Backfill a channel's history — asks for an explicit confirm click first, since it archives messages from people who never consented (owner/admin only; archives + lore + events for everyone, derived person data for opted-in members only) |

---

## Privacy model

- **Dormant by default.** New servers observe nothing: the bot posts a disclosure card on join and stays paused until an admin runs `/memory-resume`. Removing the bot from a server deletes every row it stored there — keys included.
- **Derived data is opt-in.** Person memories, relationship observations, attributes, profiles, and dossiers form only for members who consent (`/opt-in`, or `/profile-build` which opts in and backfills). Server lore and events are shared context and don't need per-member consent.
- **Reads are gated too.** Non-consenting members have nothing to read — profile cards, `/memory` views, relationship pair context, and the model's lookup tools all hide stragglers.
- **Relationship consent is subject-consent.** An observation persists when at least one party opted in — requiring both would lose almost all graph data.
- **Pause means pause.** `/memory-pause` stops archiving entirely — no raw rows, no member-registry writes — not just extraction.
- **Opt-out is strong.** `/opt-out` revokes consent, forgets memories, deletes relationships and the profile, and blocks all new derived data.
- **Deletes propagate.** Deleting a Discord message removes its archive row *and* scrubs the verbatim quote/snapshot on any evidence it produced. Edits update the archive (extraction-time snapshots are kept as the historical record).
- **Retention is bounded.** Raw messages age out on `RAW_MESSAGE_RETENTION_DAYS`; curated evidence outlives the raw archive by design.
- **Self-service.** Every member can see, export, correct, and forget their own data without admin involvement.
- **One-shot purge.** `scripts/purge-nonopted.mjs` (`PURGE_CONFIRM=1`) hard-deletes the pre-consent derived corpus for members who never opted in — run once after deploying the consent model.

Legal: [Privacy Policy](PRIVACY.md) · [Terms of Service](TERMS.md) · [Security](SECURITY.md) — also mirrored publicly at [Alby2007/ASB-Docs](https://github.com/Alby2007/ASB-Docs) for Discord verification.

---

## Quick start

_A hosted instance (bring-your-own-key) is planned — invite link lands here when it exists. Until then, self-host:_

**Prerequisites:** Node.js 20+, a Postgres database (a free [Supabase](https://supabase.com) project works — use the Session pooler URL), a Discord bot token with the Message Content intent, and a Groq API key.

```bash
git clone https://github.com/Alby2007/characterly.git
cd characterly
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, GROQ_API_KEY, KEY_ENCRYPTION_SECRET, DATABASE_URL
npm run dev            # or: npm start
```

Migrations apply automatically on first boot — no manual SQL.

**Backfill history** (optional): `INGEST_CHANNEL=channel-name npm run ingest` runs the server-level historical build — archives + lore + events for everyone, derived person data for opted-in members only. The identical routine is available in-bot as `/server-build` (owner/admin).

### Key configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Base model for replies, extraction, synthesis |
| `GUILD_ID` | *(all guilds)* | Restrict to one server — recommended while testing |
| `SPEAK_THRESHOLD` | `0.70` | Minimum `decide()` score to speak; 0.70 ≈ mentions only |
| `RAW_MESSAGE_RETENTION_DAYS` | `30` | Raw archive retention window |
| `CANDIDATE_CONFIDENCE_THRESHOLD` | `0.70` | Confidence needed for candidate → active promotion |
| `VERIFY_MODEL` … `REPLY_TOOLS` | per-workload | Model overrides and reply-tool toggles |

Full reference: [docs/configuration.md](docs/configuration.md)

---

## Development

```bash
npm run check   # typecheck (tsc --noEmit, strict)
npm test        # node:test suite — DB tests need TEST_DATABASE_URL
```

15 co-located `*.test.ts` files cover the confidence math, evidence lifecycle, dedup, entity resolution, command authorization, attribute provenance cascades, and the LLM prompt parsers (via an injected fake client). DB-backed tests run in CI against Postgres 16.

Docs: [architecture](docs/architecture.md) · [schema](docs/schema.md) · [event pipeline](docs/event-pipeline.md) · [development guide](docs/development.md)

### Layout

```
src/
  index.ts        # Discord wiring: handlers, retention, sweep, shutdown
  brain.ts        # every LLM call (injectable client for tests)
  database.ts     # MemoryStore — memories, evidence, lifecycle, maintenance
  attributes.ts   # profile_attributes: provenance-backed structured facets
  profiles.ts     # profile cards + dossier assembly
  commands.ts     # slash commands (authz matrix under test)
  perception.ts   # durable-signal pre-filter, naming detection
  entity-resolution.ts / events.ts / contest.ts / ingest.ts / retry.ts / …
scripts/          # ops tools (sweeps, backfills, verification) — run via tsx
```
