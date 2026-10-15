# Companion Marketplace — the full flow

The marketplace is a Character.AI-style discovery layer built on top of (never
replacing) the permanent awakened-companion bond. Creators publish characters
into a forum channel in the hub Discord server; adopters add them and chat in
DMs, then can summon them into servers. This doc is the end-to-end reference.

## The mental model — three different things

| Concept | What it is | Cardinality |
|---------|-----------|-------------|
| **Awakened companion** | Your one permanent bonded companion. Sacred, locked on activation. | 1 per account, forever |
| **Listing** (`companion_listings`) | A character *on the shelf* — authored, publishable content. May or may not project an awakened companion. | `FREE_LISTING_SLOTS` (default 2) live per free account; unlimited on Premium |
| **Adoption** (`companion_adoptions` + a cloned `companions` row) | A *copy* of a listing owned by the adopter — their own relationship, memories, journal, billing. | `FREE_ADOPTION_SLOTS` (default 1) active per free account; unlimited on Premium |

Adoption ≠ awakening. An adopted companion is a `companions` row with
`kind='adopted'` owned by the adopter — all the existing machinery (memories,
journal, webhooks, scene router, hosted credits/BYOK) resolves per-adopter with
zero special cases, and creators never pay for strangers' chats. The awakened
uniqueness survives via the partial index
`companions_one_awakened (owner_user_id) WHERE kind='awakened'`.

## Publishing — two paths

### Path A: publish your awakened companion — `/companion action:publish`

Gates, in order: `MARKETPLACE_CHANNEL_ID` set → caller owns an awakened
`active` companion → linked web account (`/link` + site account — accountability
for moderation) → listing-slot check (only for *new* listings; republishing is
always allowed).

Modal (`market_publish:<companionId>`): **display name**, **tagline** (card
blurb), **greeting** (the character's first DM to an adopter). On first publish
the persona is cloned from the companion; on republish the existing listing
persona is preserved and only name/tagline/greeting update — persona edits go
through **Edit persona** (`market:editmodal` → `market_edit:<listingId>` modal:
name, voice, traits, bond, backstory).

### Path B: author a freehand character — `/companion action:create`

For characters not tied to your awakened bond (v35 — `source_companion_id` is
nullable and stays NULL). Gates: marketplace configured → linked account → slot
check. Modal: name, tagline, greeting, voice, optional backstory. Traits/dynamic
start as defaults; the **Edit persona** button on the success reply fills them
in. `create` does *not* require an awakened companion — a pure creator can join,
link, and stock the shelf.

### What the bot does with a publish (both paths)

1. Writes/updates the `companion_listings` row (`upsertListing` /
   `createListing`) and snapshots the persona into `companion_persona_versions`
   (audit trail — "the character said X on version 3" is checkable).
2. **The bot itself creates the forum thread** and posts the listing card —
   name, tagline, vibe, traits, add-count, `by <creator> · v<N>` footer — with
   **Add to your companions** and **Report** buttons (`market:add:<id>` /
   `market:report:<id>`). Only the bot can mint those buttons, so listings
   can't be faked by users posting links.
3. Republishing an existing listing archives the old thread (locked + archived)
   and posts a fresh card — it does not edit in place.
4. The success reply offers **Edit persona**; persona updates bump `version`
   and `propagateListingVersion` pushes persona fields into every adopted
   clone. Adopter-owned state (memories, journal, guild rows, introduction
   flag) is never touched.

## Adopting

Forum card → **Add** → `store.adoptListing` in one transaction:

- **Slot check** — free: `FREE_ADOPTION_SLOTS` active adoption; Premium:
  uncapped; self-host lane: uncapped (no billing to meter).
- **Cooldown check** — if the listing was dropped within
  `ADOPTION_COOLDOWN_MS` (12h), Add is refused with the unlock time.
- **Clone** — a `kind='adopted'` companions row is inserted owned by the
  adopter, plus the `companion_adoptions` row. Re-adopting the same listing
  reuses the same clone, so the relationship and memories continue.
- **DM activation** — the clone becomes `active_dm_companion_id` (answers DMs),
  and the greeting is sent as the character. `dm_introduced_at` stamps **only
  on a successful send**; if DMs are closed, the greeting replays on the user's
  next DM contact.
- **Introduction gate** — adopted companions can't be server-summoned until
  `dm_introduced_at` is set; an early summon attempt gets an ephemeral warning.
- `getCompanionByOwner` stays awakened-only, so onboarding, avatar edits, and
  the permanent-lock semantics are untouched. `resolveDmCompanion` picks the
  active DM companion; `listCompanionsForUser` is the roster (awakened first).

Roster commands: `switch` (pick who answers DMs), `drop` (picker →
`market:drop`), `summon`/`dismiss` (pickers when >1), `card`, `status`.

## Dropping & cooldown

`/companion action:drop` → picker → `dropAdoption` transactionally: sets
`dropped_at` + `cooldown_until` (12h), deactivates the clone's
`guild_companions` rows everywhere, and clears the DM pick (falls back to
awakened). The clone's `companions` row and its memories are **kept** —
re-adoption after cooldown resumes the same relationship. The freed slot is
usable immediately for *other* listings.

## Money

Adopters pay for their own turns — their tokens or BYOK key, exactly like an
awakened companion. Clone `owner_user_id` = adopter, so `brainForUser`,
`spendCredits`, journals, and memory scopes all resolve to the adopter; a
popular character costs its creator nothing. Publishing/creating requires a
linked account for accountability — adoption itself doesn't.

## Moderation (foundations)

- **Report** button — `listing_reports` dedupes one report per (listing,
  user). Each insert bumps `report_count`.
- **Auto-flag** — at `MARKETPLACE_REPORT_FLAG_THRESHOLD` (3) the listing
  becomes `flagged`: new Adds are refused, existing adopters unaffected. A
  republish does **not** clear a flag (only delisted → active revives).
- **Mod channel** — `MARKETPLACE_MOD_CHANNEL_ID` gets a ping on every report.
- **Unpublish** — `/companion action:unpublish` (picker when >1 listing) →
  `delisted` + thread locked/archived. Delisted blocks Adds; adopters keep
  their companions. Emergency SQL delist:
  `UPDATE companion_listings SET status='delisted' WHERE id=<n>;`

## Config reference

| Env | Default | Meaning |
|-----|---------|---------|
| `MARKETPLACE_CHANNEL_ID` | unset → publishing disabled | Forum channel in the hub server |
| `MARKETPLACE_MOD_CHANNEL_ID` | unset | Text channel pinged on reports |
| `FREE_ADOPTION_SLOTS` | 1 | Active adoptions per free account |
| `FREE_LISTING_SLOTS` | 2 | Live listings per free account |
| `ADOPTION_COOLDOWN_MS` | 43200000 (12h) | Re-adopt lockout after a drop |
| `MARKETPLACE_REPORT_FLAG_THRESHOLD` | 3 | Reports that auto-flag a listing |

Bot needs **Create Public Threads** (+ **Manage Threads** for clean archiving)
in the forum channel.

## Known rough edges / next-phase candidates

- Republish posts a new thread rather than editing — a popular listing's
  comments don't carry over.
- Forum tags aren't applied (Discord needs the forum's tag IDs) — add
  `MARKETPLACE_TAG_MAP` or a tag picklist for browsability.
- Flagged listings keep their thread visible (Adds are blocked at the button);
  auto-archiving on flag is a small change if wanted.
- Delisting is soft by design; hard removal of a listing's clone rows is a
  moderation-phase decision.
- Full moderation/NSFW/age policy is deliberately a later phase — reports,
  flagging, and delisting are the foundations.
