# Characterly

A Discord companion & social-memory platform where every person awakens **one permanent personal AI companion** in 1:1 DMs, discovers and adopts more characters from the **companion marketplace**, and brings them into shared Discord servers.

In servers, the **Characterly** bot is invisible plumbing and a system announcer — it never speaks in character. Instead, it routes conversations across summoned companions, posts their replies under their own name and avatar via Discord webhooks, bridges private DM subtext with group server activity, and maintains an inspectable, consent-gated memory and relationship graph.

---

## Core Concepts

### 1. Companion Marketplace — the discovery layer

The marketplace is a Character.AI-style storefront living in a forum channel on the Characterly hub server, layered on top of (never replacing) the permanent awakened bond. Full reference: **[docs/marketplace.md](docs/marketplace.md)**.

- **Bot-minted listings.** The bot itself creates the forum thread and posts the card — name, cover art, tagline, vibe, traits, star rating, add-count — with **Add** / **Rate** / **Report** buttons, so listings can't be faked by users posting links. Republish posts a fresh thread rather than editing in place.
- **Three ways to publish:** `/companion publish` lists your awakened companion (persona cloned, edits propagate to adopters as versions); `/companion create` authors freehand characters that don't consume your awakened slot; `/companion import` (or the dashboard) brings in standard character-card `.json`/`.png` files — imports stay private-unlisted until published.
- **Adopt, don't awaken.** Clicking **Add** clones the listing into a `kind='adopted'` companion owned by the adopter — their own memories, journal, relationships, and billing. The character opens a private `#adoptees` thread in the hub server with the creator-written greeting, then can be summoned into other servers. Re-adopting after a drop resumes the *same* clone *and thread*, so the relationship and chat history continue.
- **Gates & slots.** Free accounts hold 1 active adoption and 2 live listings; Premium is uncapped on both. A dropped companion locks re-adoption for 12 hours. Hosted-lane adopters need a linked Characterly account (or a BYOK key) — **Add** fails early for unlinked users with an ephemeral pointer at the verify channel, instead of handing them a companion they can't talk to.
- **Discovery surface.** Listing threads double as comment sections — readable by everyone, writable by verified Members. An ephemeral ★1–5 picker (one vote per user, re-rating upserts) refreshes the card's average live. Creators tag listings (≤3 from the forum taxonomy: Romance, Anime, Games, Fandom, Fantasy, …); the bot manages curated badges — `New`, `Top Rated`, `Trending`, `Staff Pick` — recomputed by a sweep against live stats. Gallery View covers come from the card's image or attached art.
- **Moderation is a feature, not a checkbox** ([docs/moderation.md](docs/moderation.md)): publish/edit screening is fail-closed (blocklist + model verdict), adopted-companion replies are screened on both lanes (fail-open → neutral refusal + refund), categorized reports auto-flag at threshold and ping mods with Keep/Delist/Ban/Ban-creator buttons, message-level comment reports carry their own action row, house automod covers the threads, and `banned` listings freeze every clone.
- **Billing follows the chatter:** adopters pay for their own turns (tokens or BYOK) — a popular character never costs its creator a cent. An official seed roster (`/ops action:seedmarket`) stocks the shelf with first-party personas.

### 2. One Permanent Companion Per Account (Awakened in 1:1 DMs)
- Users DM Characterly (or click **Awaken Your Companion** in any Characterly server) to shape their companion through a short slice-of-life conversation, 1-click starter archetypes (**Chaotic Co-Conspirator**, **Dry & Deadpan**, **Ride-or-Die**, **Surprise Me**), or a direct form modal.
- Every turn renders a live **Companion Draft** card showing `Name`, `Bond / Dynamic`, `Voice & Vibe`, `Core Traits`, `Backstory`, and `Avatar` (attach any image in DMs to give them a face).
- **Permanent Lock:** Once a user clicks **Awaken & Lock In**, their companion's identity is **permanently bound to their account** (`1 companion per account` — adoptions live alongside it, never replacing it).

### 3. User-First Personal AI Keys (Auto-Detected Providers)
- Each user connects their own API key (`dm:<userId>`) via the onboarding **Paste API Key** button or `/companion key`.
- Users only paste their API key and **leave the Base URL field blank** — Characterly automatically detects the provider and default model from the key prefix:
  - `gsk_...` → **Groq** (`openai/gpt-oss-120b`)
  - `sk-or-...` → **OpenRouter** (`openai/gpt-oss-120b`)
  - `sk-...` → **OpenAI** (`gpt-4o-mini`)
  - `xai-...` → **xAI** (`grok-3-mini`)
- Keys are validated live against `/models` and encrypted at rest with **AES-256-GCM** (`KEY_ENCRYPTION_SECRET`). A user's personal key powers their companion in DMs and in every server they summon them into.

### 4. Characterly as Server Plumbing (1-Click Server Setup)
- When added to a Discord server, Characterly posts a welcome card and starts **dormant**.
- A server admin clicks **Enable Characterly (Admins)** on the card (or runs `/server resume`) — **no server API key is required**.
- Members summon their companions with `/companion summon` (or 1-click **Summon to `<Server>`** buttons in DMs). Characterly announces **`System · <Name> joined the chat`** when a companion arrives and **`System · <Name> left the chat`** when dismissed.

### 5. Multi-Companion Scene Routing & Webhook Identity
- **Webhook Disguise (`src/webhooks.ts`):** Summoned companions speak through a cached channel webhook (`Characterly Companions`) disguised with their own name and avatar (including inside threads). If `Manage Webhooks` permission is missing, Characterly posts a system permission notice rather than roleplaying as the companion.
- **Scene Router (`src/scene-router.ts`):** Coordinates multiple summoned companions in the same channel:
  - **Direct Address (`+0.85`):** Saying a companion's name (`detectWakeWord`) or replying to that companion's webhook message routes the turn to that companion and suppresses unaddressed companions.
  - **Per-Companion Engagement (`+0.70`):** Each companion tracks its own active conversation participants while sharing the channel floor for share-of-voice pacing.
  - **Owner Affinity (`+0.15`):** Companions prioritize turns where their owner is engaged or asking a question.
  - **Bounded Companion-to-Companion Banter:** Companions can address and reply to each other up to `MAX_COMPANION_CHAIN_DEPTH` (default `2` hops per human message) before hard-stopping.

### 6. Cross-Context Consciousness (DM ↔ Server Bridge)
- **DM → Server (Vault Rule):** When speaking in a server, a companion receives high-confidence memories and facets from its private 1:1 DMs with its owner (`gatherOwnerSubtextForServer`) under a strict **VAULT RULE** — used only for subtext, loyalty, and inside jokes, never disclosed to other server members.
- **Server → DM:** When chatting in 1:1 DMs, a companion receives a digest of recent events, relationship edges, and activity from the servers where it is summoned (`gatherServerDigestForDm`) so it can debrief and gossip with its owner.

### 7. Provenance-Backed Memory, Relationships & Events
- **Deterministic Confidence & Sincerity Verification:** Candidate memories and relationship observations are verified against source context (`literal` / `joke` / `misattributed` / `unclear`) before activating; numeric confidence is computed deterministically (`src/confidence.ts`).
- **Provenance Facets, Profiles & Dossiers:** Structured `profile_attributes` cite the exact `memory_ids` that justify them — forgetting or superseding a memory cascades immediately to any facet citing it.
- **Behavioral Relationship Intelligence:** Combines verified single-message claims with the 90-day interaction graph and holistic `pair-analysis` exchange-window reads (`warming` / `cooling` trends).
- **Hybrid semantic recall (v40, opt-in):** memories and journal entries carry `pgvector` embeddings alongside the lexical recall legs, so paraphrases surface too. Any OpenAI-compatible `/embeddings` endpoint works (local Ollama by default — `EMBED_BASE_URL` unset disables it cleanly).

### 8. First-Person Companion Journal
- After each reply, a deferred `journal-write` job lets the companion write 0–2 **first-person** entries ("Alice and I roasted her tea take") into `companion_journal` — its own episodic memory, origin-tagged to the scope where it happened.
- Entries recall only in their origin scope (guild entries in that server, DM entries in the DM) and via the Vault subtext lane; consent-gated like extraction, covered by `/opt-out` and `/memory export`, and dormant-but-retained when a companion is dismissed.

### 9. Web Accounts, Website & Discord Linking
- A Vite site (`website/`) hosts the landing page plus **Characterly accounts** (Supabase Auth: email/password, magic link, Discord OAuth) and an account dashboard — deployed as Cloudflare Workers Static Assets.
- `web_profiles` links the "real-life" account to the Discord user via `discord_user_id` — written only by the `auth.identities` sync trigger (OAuth/`linkIdentity`) or the `claim_link_code` rpc behind `/link`; users can never write it directly. A Discord username/avatar snapshot rides the link so code-linked accounts render an avatar in the dashboard the same as OAuth ones.
- **The dashboard** covers profile, Discord link/unlink, hosted **Tokens** (balance, plan, ledger), **Companion settings** (companion-to-companion replies, low-token alerts, BYOK status), **Billing** (Premium subscription + token packs through a Stripe Checkout edge function), character-card **import**, password change, and guarded **delete account**.
- **Terms clickwrap** (`consent_events`, `TERMS_VERSION`): the signup checkbox and the Discord verify button both record acceptance — one acceptance covers web and bot.
- Legal documents are hosted on the site at `/terms`, `/privacy`, `/security` — rendered from the repo's `TERMS.md`/`PRIVACY.md`/`SECURITY.md` at build time.

### 10. Hosted Lane & Tokens (Credits)

- **Two lanes:** BYOK stays the power-user lane — a personal key means unlimited chat, no account needed. Without a key, companions run on the **hosted lane** (the operator's env model) which requires a **linked Characterly account** (`/link`) and spends **tokens**.
- **Payer-per-turn:** a human's turn costs 2 tokens (their message + the companion reply — both refunded if no reply lands, or if an adopted companion's reply is swapped for the safety refusal); companion↔companion hops bill the replying companion's owner 1, gated by their c2c dashboard toggle. Nobody can burn someone else's tokens.
- **Two buckets, lazy refills:** the balance is a daily allowance plus a persistent pack slice (`web_profiles.purchased_balance`, v60). The allowance refills to 30 (free) / 150 (premium) each UTC day regardless of pack tokens, and is always spent first; packs and the launch bonus never expire and never suppress the refill. Applied atomically inside the spend transaction (`credit_ledger` audits every change). No scheduler.
- **Onboarding:** the first `ONBOARDING_FREE_TURNS` (default 8) hosted draft turns are free; after that each draft turn costs a normal 2-token turn. Locking in and **Edit Draft** stay free. BYOK never pays.
- **Premium ($7.99/mo) & token packs** are sold through Stripe Checkout sessions minted by the `create-checkout` edge function and fulfilled by the `stripe-webhook` edge function (idempotent on session id). Refunds claw back exactly the pack the charge paid for (matched on `payment_intent`, prorated for partial refunds) — subscription refunds never touch pack tokens. Premium uncaps marketplace slots and raises the daily token floor.
- **Fleet breaker:** `HOSTED_DAILY_LLM_CAP` bounds total hosted calls/day independent of credits; BYOK calls never count. Background cognition (extraction, journals, recaps, triage, maintenance) may use at most `HOSTED_BACKGROUND_SHARE` (default 40%) of it, so jobs can't starve live chat.
- **Free-tier throttle:** extraction + journaling for free hosted users coalesce into hourly batches (freshness, not quality); premium and BYOK run live.

### 11. The Hub Server — welcome, verify, Member gate

The Characterly community server is where the marketplace lives (`src/ops.ts`, gated on `HOUSE_GUILD_ID`):

- **Welcome at join** — the greeting lands the moment someone joins (pending rules-accepted or not), pointing them at the rules and the gate; a per-boot dedupe plus a `pending→false` fallback means raid-window-suppressed joins still get greeted without double-posts.
- **Verify gate** — `Member` means *verified Characterly member*. `@everyone` sees the lobby + the marketplace (browse-only); the persistent card in the gate channel's **Verify** button walks: accept rules → linked account (site + `/link` if missing) → Terms/Privacy clickwrap → Member role.
- **Link sweep** — unlinking on the website auto-revokes Member within minutes (a lookup *error* keeps the role — an outage can't mass-revoke).
- **Automod** — deterministic invite-link, scam, mass-mention, burst-spam, and new-account rules run before any memory pipeline; marketplace comments inherit them.
- **Support tickets** — `#support-ticket` is visible pre-verify (so "can't log in" cases still reach staff) but read-only; its persistent **Open a ticket** card opens a modal that files a private thread between the user and staff (one open ticket per account, enforced by a partial unique index). Ticket threads are excluded from automod and the memory pipeline — support conversations never become companion memory.
- **Adoptee threads** — `#adoptees` holds one named private thread per adoption: the adopter's chat surface with their companion. Turns there run the same pipeline as DMs under the adopter's personal scope (their credits/BYOK, memory, journals); thread history stays per-companion automatically. Private threads are moderator-visible for safety; automod stays out of them.

---

## Commands

All command replies are ephemeral (private to the invoker) unless noted; companion arrivals and departures post public system notices.

### Companions & Members

| Command | What it does |
|---------|--------------|
| `/companion card` | View your (or another member's) awakened companion card and relationships |
| `/companion list` | See all companions currently active in this server and how to address them |
| `/companion summon` | Summon your personal companion into this Discord server |
| `/companion dismiss` | Dismiss your companion from this server |
| `/companion key` | Connect or rotate your personal AI API key (leave Base URL blank for auto-detection) |
| `/companion status` | Check your personal API key status, active servers, and today's DM usage |
| `/companion avatar` | Update your companion's avatar (URL or upload) |
| `/companion tokens` | Hosted-token balance (daily vs pack split) and when the daily refill lands |
| `/companion story` / `reset-story` | View/edit your companion's running "story so far" recap, or start a fresh chapter |
| `/companion imports` | View or undo your chat-history imports |
| `/companion edit` / `reset` | Edit or restart your companion's persona before awakening |
| `/memory list` | List your active memories (8/page; `page:`, `search:`, `memory_id:` to inspect provenance, `pin:` to pin/unpin, `candidates:true` for unconfirmed, `server:true` for lore) |
| `/memory remember` | Pin a fact you state yourself — always in context |
| `/memory confirm` | Promote one of your own candidate memories to active |
| `/memory export` | Download every memory + evidence held about you |
| `/memory forget` | Forget one of your memories (confirmation button required) |
| `/memory correct` | Replace a memory — supersedes genuinely contradictory active ones |
| `/memory event` | Inspect the server event a memory is attached to |
| `/memory share-facts` | (Server) let companions carry facts about you into their owners' DM digests — off by default |
| `/privacy` | See what Characterly stores in this server, the retention window, and your consent state |
| `/opt-out` | Forget everything about you, delete your profile, revoke consent |
| `/opt-in` | Consent to memories + a profile about you (live activity only) |
| `/profile-build` | Opt in **and** scan your archive history to build your structured profile now (once per 24h) |
| `/profile` | View your profile card (another member's: admins only) |
| `/dossier` | Deep dossier — voice, life situation, temperament, beliefs, relationship map, reputation, timeline |
| `/link` | Get a one-time code to link this Discord account to your Characterly web account |

### Marketplace

| Command | What it does |
|---------|--------------|
| `/companion publish` | List your awakened companion in the hub server's marketplace forum (requires a linked account) |
| `/companion create` | Author a freehand marketplace character (not tied to your awakened companion) |
| `/companion import` | Bring in a character card (`.png`/`.json`) from another platform — private until published |
| `/companion unpublish` | Remove your companion's marketplace listing |
| `/companion relist` | Bring back an unpublished marketplace listing |
| `/companion homes` | Where each of your companions lives — awakened in DMs, adoptees in their `#adoptees` threads |
| `/companion drop` | Drop an adopted companion (12h re-adopt cooldown) |

On the forum card itself: **Add** adopts, **Rate** opens the star picker, **Tags** / **Cover image** / **Edit persona** are creator tools, **Report** files a categorized report; right-click → **Apps → Report message** flags a comment; **Staff pick** toggles the editorial badge (mods).

### Server Administrators (`Manage Server`)

| Command | What it does |
|---------|--------------|
| `/companion kick user:@member` | Remove a member's companion from this server |
| `/server quiet` / `/server unquiet` | Silence companions in a channel (defaults to the current one; threads inherit their parent) — Characterly still observes and remembers |
| `/server companions-pause` / `companions-resume` | Silence companions server-wide — memory collection keeps running |
| `/server pause` / `/server resume` | Pause or enable Characterly in this server — archiving included |
| `/server ignore` / `/server unignore` | Make a channel invisible to Characterly — no archiving, no replies, no member writes |
| `/server settings` | Show effective server settings (including ignored and quiet channels and daily LLM cap) |
| `/server limits` | Set this server's daily LLM-call cap (0 = block all calls; usage resets each UTC day) |
| `/server status` | Uptime, operational counters, active summoned companions, queue health, today's LLM usage vs cap |
| `/server triage` | Newest memories across all members + contested attributes |
| `/server purge` | Purge raw archived messages older than N days |
| `/memory list about:@member` | Inspect another member's memories |
| `/memory list stats:true` | Server memory counts |
| `/setup` | Connect a server-wide API key (optional — members' own keys work without it) |

A private `/ops` console (`/ops action:status|logs|restart|deploy|announce|layout|seedmarket`) controls the host and house layout — allowlisted via `OPS_USER_IDS`, documented in [docs/operations.md](docs/operations.md).

---

## Privacy & Security Model

- **Dormant by default in servers.** New servers observe nothing until an admin clicks **Enable Characterly** or runs `/server resume`. Removing Characterly from a server deletes every row it stored there. Admins then get a tiered dial per scope: **quiet** a channel (companions silent, still observed) → **pause companions** (silent server-wide) → **pause memory** (all off) → **ignore** a channel (fully invisible, no archive either).
- **Derived data is opt-in.** Person memories, relationship observations, attributes, profiles, and dossiers form only for members who consent (`/opt-in`, `/profile-build`, or summoning a companion).
- **The Vault Rule (DM → Server isolation).** Private 1:1 DM memories are never exposed to other server members or lookup tools; they inform only the companion's internal subtext with its owner.
- **Encrypted keys & SSRF guards.** Personal API keys are encrypted at rest with AES-256-GCM (`src/secrets.ts`), scrubbed from logs, and custom endpoints are protected against DNS-rebinding SSRF at socket connect time (`src/brains.ts`, `src/tools.ts`).
- **Deletes propagate & retention is bounded.** Deleting a Discord message removes its archive row and scrubs verbatim quotes on any evidence it produced; raw messages age out on `RAW_MESSAGE_RETENTION_DAYS`.
- **Marketplace safety.** Published personas are screened fail-closed, adopted replies fail-open into a safe refusal, self-harm phrasing in any DM gets a scripted crisis-resource response, and listing threads are moderated but never mined for memory.

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

Migrations (`v1`–`v61`) apply automatically on first boot — no manual SQL.

### Key Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `DISCORD_TOKEN` | *(required)* | Discord bot token |
| `DATABASE_URL` | *(required)* | Postgres connection string |
| `KEY_ENCRYPTION_SECRET` | *(recommended)* | AES-256-GCM master passphrase for encrypting user API keys |
| `GROQ_API_KEY` | *(optional)* | Operator fallback key when `REQUIRE_GUILD_KEYS=0` |
| `REQUIRE_GUILD_KEYS` | `0` | `1` requires users to connect their own personal API key (`dm:<userId>`) |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Default base model |
| `SITE_URL` | `https://characterly.app` | Public website URL — where `/link` and verify flows point users |
| `MARKETPLACE_CHANNEL_ID` | *(off)* | Forum channel in the hub server — unset disables publishing |
| `HOUSE_GUILD_ID` | *(off)* | Hub server id — gates welcomes, verify gate, automod, `/ops` |
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

Docs: [Architecture](docs/architecture.md) · [Marketplace](docs/marketplace.md) · [Moderation](docs/moderation.md) · [Database Schema](docs/schema.md) · [Event Pipeline](docs/event-pipeline.md) · [Configuration](docs/configuration.md) · [Website & Accounts](docs/website.md) · [Operations](docs/operations.md) · [Developer Guide](docs/development.md)

### Layout

```
src/
  index.ts          # Discord client, 1:1 DM onboarding & chat loop, server message loop, maintenance
  scene-router.ts   # Multi-companion scene router & companion-to-companion chain-depth guard
  webhooks.ts       # Per-companion Discord channel webhook sender & thread routing
  cross-context.ts  # Asymmetric DM <-> Server consciousness bridges (Vault Rule + server digest)
  marketplace.ts    # Listing cards, forum threads, adopt/drop, ratings, tags, reports
  safety.ts         # Listing/reply content screens + self-harm triage
  seed-personas.ts  # Official marketplace seed roster (/ops action:seedmarket)
  ops.ts            # House ops: welcomes, verify gate, automod, layout, tag sweep, /ops console
  brains.ts         # User-first Brain resolver & API key prefix provider/model auto-detection
  brain.ts          # All LLM calls (onboarding, extraction, verification, replies)
  database.ts       # MemoryStore — companions, credits, webhooks, memories, evidence, relationships
  charcard.ts       # Shared character-card parser (v1/v2/v3 .json/.png imports)
  embeddings.ts     # Opt-in OpenAI-compatible embeddings for semantic recall
  commands.ts       # Slash commands, onboarding cards/modals, interaction handlers
  attributes.ts / profiles.ts / dossier.ts / events.ts / jobs.ts / journal-job.ts / ...
website/            # Vite site — landing + accounts/dashboard, deployed to Cloudflare Workers
scripts/            # Ops utilities (sweeps, backfills, verification, dead-letter requeue)
supabase/           # Edge functions (create-checkout, stripe-webhook) + auth email templates
```
