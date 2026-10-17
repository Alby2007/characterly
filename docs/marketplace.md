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
for moderation) → listing-slot check. The check is advisory at the action and
**atomic at submit**: `upsertListing` enforces the cap inside its transaction
under a per-creator advisory lock, and it applies whenever the write adds a
live listing — a new listing, or a delisted → active *revive*. Republishing an
already-live listing is the only free path.

Modal (`market_publish:<companionId>`): **display name**, **tagline** (card
blurb), **greeting** (the character's first DM to an adopter), and **cover
image URL** (optional — prefilled with the current cover, so clearing it
removes the art). On first publish the persona is cloned from the companion;
on republish the existing listing persona is preserved and only the modal
fields update — persona edits go through **Edit persona** (`market:editmodal`
→ `market_edit:<listingId>` modal: name, voice, traits, bond, backstory).

### Path B: author a freehand character — `/companion action:create`

For characters not tied to your awakened bond (v35 — `source_companion_id` is
nullable and stays NULL). Gates: marketplace configured → linked account → slot
check (same atomic enforcement as `publish`). Modal: name, tagline, greeting,
voice, optional backstory. Traits/dynamic start as defaults; the **Edit
persona** button on the success reply fills them in, and **Cover image** adds
the art. `create` does *not* require an awakened companion — a pure creator
can join, link, and stock the shelf.

### Path C: import a character card — `/companion action:import` or the dashboard

Users can bring a standard **character card** (`.json` or a `.png` card with an
embedded `tEXt`/`ccv3` payload — the portable v1/v2/v3 format shared by
character tools and card libraries). The shared parser (`src/charcard.ts`,
bundled into the website too) normalizes the card into persona fields and
stamps `persona_source='card_import'` + `import_meta` (spec, claimed creator,
filename, `sha256` of the source bytes) on both rows.

**Private by default.** An import creates a `status='unlisted'` listing plus an
adopted clone owned by the importer — invisible to marketplace queries and live
listing caps, adoptable only by its creator. First import claims the DM pick;
the awakened companion is never touched. Discord: preview → confirm. Website:
the dashboard's "Import a character" plate parses the file client-side, shows a
preview, uploads an extracted PNG avatar to the `card-avatars` bucket, and
creates the pair via the `import_companion_card` RPC (idempotent on `sha256` —
re-importing the same file reuses the row).

**Publishing an import** goes through the normal flow: `/companion
action:publish` offers an unlisted-import picker before the awakened modal;
`publishListing` flips `unlisted → active` with the usual slot cap, daily cap,
and content screen. An imported card gets a subtle "Imported character card"
line on its marketplace card — authorship is never asserted, only provenance.

### What the bot does with a publish (all paths)

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

## Discussion on the listing — comments, ratings, and comment moderation

Each listing thread doubles as its comment section. The boundaries are
deliberate:

- **Who can read** — everyone (`@everyone` sees the marketplace category; the
  shelf is the shop window). **Who can post comments** — verified Members +
  Mod/Admin only (`SendMessagesInThreads` is denied to `@everyone`, so
  unverified browsers can't talk). Thread creation is bot-only —
  `SendMessages` is denied to every role, so the card schema can't be faked.
- **Star ratings (v37)** — the card carries a **Rate** button
  (`market:rate:<id>`) → an ephemeral ★1–5 picker (`market:rateval:<id>:<n>`).
  One vote per user per listing (re-rating upserts); the card embed shows
  `★ avg · n ratings` and refreshes on each vote. Creators can't rate their
  own listing; on the house guild the voter must hold the Member role (or be
  marketplace staff — mods may not carry Member). Stored in
  `listing_ratings`.
- **Comment reports** — right-click → **Apps → Report message** (a
  `MESSAGE`-type context command) works only inside marketplace threads. It
  opens the same category picker as listing reports (minus *stolen persona*),
  writes a `comment_reports` row (deduped per `(message, reporter)`), and
  pings `MARKETPLACE_MOD_CHANNEL_ID` with the quoted excerpt (mention-parsing
  suppressed — a report can't be weaponized into a ping), the jump link, and
  **Keep / Delete comment / Timeout author (10m)** buttons
  (`market:modmsg:<action>:<channelId>:<messageId>:<authorId>`), gated to the
  same `isMarketplaceMod` check. The author for Timeout resolves from the
  stored report row, not the button id.
- **Moderation coverage** — house automod runs on every guild message
  *before* any other handling, so comments get the same invite-link, scam,
  mass-mention, burst-spam, and new-account-link rules as the rest of the
  server, plus the `checkMessageContent` hard-line screen (slurs,
  minor-safety, self-harm promo, illegal content → delete + 30m timeout).
- **Not memory** — listing-thread messages return early from the pipeline
  after automod: no archive rows, no memory extraction, no companion
  selection/replies, no awaken/summon notices. Comments are public discourse,
  not remembered material (`isMarketplaceThread` — a thread whose parent is
  `MARKETPLACE_CHANNEL_ID`).
- **Daily caps** — comment reports share the reporter's
  `MARKET_REPORT_DAILY_CAP` budget with listing reports (same
  `report:<userId>` advisory lock and combined count inside the transaction).
4. The success reply offers **Edit persona**; persona updates bump `version`
   and `propagateListingVersion` pushes persona fields into every adopted
   clone. Adopter-owned state (memories, journal, guild rows, introduction
   flag) is never touched.

## Listing tags — creator picks + curated badges

Forum tags are the browse surface. Two lanes, both resolved against the
forum channel's `availableTags` **live by name** — no ids are stored, so a
tag renamed or deleted in Discord self-heals (a deleted id just drops out of
the next `setAppliedTags` write):

- **Creator tags** — every *non-moderated* tag on the forum is pickable, up
  to three per listing (the same cap c.ai puts on categories — keeps tags
  meaningful instead of everything wearing every tag). The seeded taxonomy:
  Romance, Anime, Games, Fandom, Fantasy, Sci-Fi, Horror, OC, RPG,
  Companion, Helpers, Comedy, Historical, Slice of Life, Adventure —
  roughly c.ai's biggest categories compressed into forum-tag budget.
  Publishing, republishing, and relisting attach an ephemeral multi-select
  (`market:tagsel:<listingId>`) to the success reply, and the card's **Tags**
  button (`market:tags:<id>`, creator-only) reopens it for re-tagging later.
  The submit handler re-checks ownership, drops forged tag ids against the
  live forum list, and merges the thread's moderated badges back in — a
  re-tag replaces only the creator's own picks.
- **Curated badges** — four *moderated* tags the bot manages. The tag
  **names are the contract**: `New`, `Top Rated`, `Trending`, `Staff Pick`,
  matched case-insensitively (`CURATED_TAGS` in `src/marketplace.ts`); a missing name
  skips its rule silently.
  - `New` — applied at thread creation; the tag sweep strips it once the
    thread is older than `MARKET_NEW_TAG_DAYS`.
  - `Top Rated` — `avg ≥ MARKET_TOP_RATING_AVG` (default 4.5) with at least
    `MARKET_TOP_RATING_MIN` (5) ratings, from `listing_ratings`.
  - `Trending` — `MARKET_TRENDING_COUNT` (5) adoptions inside the last
    `MARKET_TRENDING_WINDOW_H` (72h), from `companion_adoptions.adopted_at`.
  - `Staff Pick` — manual editorial badge toggled by marketplace mods via
    right-click → **Apps → Staff pick** on any message in the listing thread.
    The sweep never touches it.

The sweep (`runTagSweep`, on the host-health cadence) recomputes only the
three *automated* badges for active threads, writes only when the applied
set differs, and caps the merged set at Discord's five-tag maximum with
managed badges first. Badges belong to *active* listings — a delisted or
banned row maps to no thread and its curated tags strip on the next pass.

## The official seed roster

`src/seed-personas.ts` holds fifteen first-party personas — original
archetypes built to cover the proven demand curves on character platforms
(comfort listener, RPG narrators, cold protector, masked operative, devoted
mob boss, starship AI, chaotic gremlin, tutors and collaborators) *without*
seeding canon IP: the marketplace rules ask creators to publish work they
own, and platform-seeded copyrighted characters would undercut that before
launch.

Seeding is operator-driven — `/ops action:seedmarket` (house guild or DM,
`OPS_USER_IDS`):

- Each persona clears the *same* `checkListingFields` screen user publishes
  face, then `createListing` under the **bot's own user id** — cards read
  "by Characterly", rows are ordinary listings: adoptable, ratable,
  reportable, moderatable.
- **Idempotent by (bot, name)** — re-runs skip what exists; a delisted
  leftover (from a failed first run) relists via `relistListing` (which
  refuses mod takedowns on its own) and gets its thread re-posted; a
  flagged/moderated seed is reported and left alone.
- The comfort-listener slot is deliberately a *friend*, not a therapist —
  Wren "always has time for you"; the persona text makes no clinical or
  licensed-care claim.
- Failed thread posts roll the listing back to delisted so the next run
  retries cleanly. New threads get their genre tags plus the `New` badge.
- **Cover art** — each persona's `coverFile` names a committed asset under
  `assets/marketplace/`; it's attached to the card's OP message, which is
  what Discord uses as the thread's Gallery View cover. Re-running
  `seedmarket` patches the attachment onto pre-art threads (and swaps it
  when the file changes) — the roster never needs re-posting to refresh art.

## Gallery covers

The forum's default layout is **Gallery View** (`default_forum_layout`,
reconciled by `ensureHouseLayout` every boot — flipping it back in Discord
doesn't stick). A post's cover comes from its *first message*: a file
attachment or the embed's large `image` field (`embed.thumbnail` does not
count). That's why `buildListingCard` maps `avatarUrl` → `setImage` — a
creator's avatar URL doubles as the listing cover — and why seed personas
attach art files instead of URL-ing them (real uploads always resolve).

### Creators setting covers

Three doors, one field (`companion_listings.avatar_url`):

- **Cover image button** — every listing card carries a creator-only **Cover
  image** button (`market:cover:<id>` → `market_cover:<id>` modal). Ownership
  and the creator-ban freeze are re-checked at both the button and the modal
  submit — customIds are forgeable. Submitting a URL writes `avatar_url`,
  then `refreshListingCard` edits the OP card in place (no repost — ratings
  and comments are untouched). Submitting blank removes the cover; a card
  without one still renders normally.
- **Publish-modal field** — `action:publish`'s modal has an optional *Cover
  image URL* slot, prefilled with the listing's (then the companion's)
  current value. Whatever's in the box at submit is the new truth — blank
  clears. This also fixes the old republish semantics where an existing
  cover always won over a freshly-set companion avatar.
- **`/companion action:avatar`** — accepts `avatar_url` (validated public
  URL) *or* `avatar_file` (a Discord attachment upload; its CDN URL is used
  directly). Supplying both is refused. On an awakened companion it sets
  `companions.avatar_url`, which the publish modal picks up on next publish.

All URL inputs run `isSafeUrl` + `resolvesToPrivateAddress` — public
`http(s)` only, no private IPs, no localhost, no unresolvable hosts.

## Adopting

Forum card → **Add** → `store.adoptListing` in one transaction:

- **Link gate (hosted lane only)** — no linked account and no BYOK key →
  Add is refused with an ephemeral pointer to the verify channel (or site +
  `/link` when `HOUSE_VERIFY_CHANNEL_ID` is unset). An unlinked adopter would
  only own a companion the DM gate refuses to serve. A lookup *error* fails
  soft with a retry prompt — it's never treated as "no account". Self-host
  has no accounts at all, so the gate no-ops there.
- **Slot check** — free: `FREE_ADOPTION_SLOTS` active adoptions; Premium:
  uncapped; self-host lane: uncapped (no billing to meter). Enforced
  atomically inside the adoption transaction under a per-user advisory lock:
  anything that leaves an adoption active counts — a fresh add *and* a
  post-cooldown re-adoption. (Re-adopt is refused with `cap` when the slot is
  held by another listing — drop first, or upgrade.)
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
popular character costs its creator nothing. Publishing *and* adopting both
require a linked account (or a BYOK key) — publishing for accountability,
adopting because hosted chat is the point of the clone.

## Moderation

The full policy + enforcement spec lives in **[docs/moderation.md](moderation.md)**.
The mechanics in one paragraph:

- **Report** → a category picker (`market:reportcat`), stored per
  (listing, reporter, category) in `listing_reports` — the category is
  whitelisted against `REPORT_CATEGORIES` so a forged button can't inject
  arbitrary text into the mod ping. At `MARKETPLACE_REPORT_FLAG_THRESHOLD`
  the listing becomes `flagged` — a **moderation hold**: Adds blocked,
  creator can't delist/relist/republish the flag away; only a mod action
  clears it. Daily report cap (`MARKET_REPORT_DAILY_CAP`) blunts
  report-bombing — enforced inside the report transaction.
- **Publish screening (fail-closed)** — deterministic blocklist
  (`checkListingFields`) then `Brain.safetyVerdict` on the operator model
  (`safetyBrain()`); all three write paths (publish/create/edit) screen the
  assembled persona.
- **Reply screening (fail-open)** — adopted companions' replies (DM + guild,
  BYOK + hosted) pass `safetyVerdict` before send; a flag swaps in
  `SAFE_REFUSAL` and refunds the reply leg.
- **Self-harm triage** — `isSelfHarmSignal` on every DM; hit → scripted
  `CRISIS_RESPONSE`, no charge, no throttle.
- **Statuses** — `active` → `flagged` → `delisted` / `banned`. `delisted`
  has two flavors told apart by `moderation_events`: a *creator unpublish*
  relists freely; a *mod takedown* refuses creator relist/republish and
  hides from the relist picker — only **Keep up** restores it. `banned` is
  the kill switch: clones freeze everywhere (roster, DM, guilds) via the
  `adopted_from_listing_id → status` join, and a frozen adoption releases
  the adopter's slot until the ban lifts. **Keep up** ladders
  `banned→flagged→active`. **Creator bans** (`marketplace_bans`) ban all
  their listings + block every write path (publish, create, relist, edit).
- **Mod UX** — every report ping in `MARKETPLACE_MOD_CHANNEL_ID` carries
  **Keep up / Delist / Ban listing / Ban creator** buttons
  (`market:mod:<action>:<id>`), gated to `MARKETPLACE_MOD_ROLE_IDS`
  (fallback: ManageGuild). Actions land in `moderation_events`.
- **Comment reports** — message-level reports (right-click → *Report
  message*) land in `comment_reports`, not `listing_reports`: a bad comment
  shouldn't count toward the listing's flag threshold. Mods get
  **Keep / Delete comment / Timeout author (10m)** buttons
  (`market:modmsg:<action>:<channelId>:<messageId>:<authorId>`); the ping
  quotes the comment with mention parsing suppressed, and Timeout resolves
  the author from the stored row rather than the button id. The daily
  report cap is shared across both lanes.
- **Rate limits** — `MARKET_PUBLISH_DAILY_CAP` (5, new rows only —
  republishes/relists don't consume it), `MARKET_REPORT_DAILY_CAP` (20),
  `MARKET_ADOPT_DAILY_CAP` (20) — all per UTC day, all enforced inside the
  same advisory-locked write transactions as the slot caps.

## Config reference

| Env | Default | Meaning |
|-----|---------|---------|
| `MARKETPLACE_CHANNEL_ID` | unset → publishing disabled | Forum channel in the hub server |
| `MARKETPLACE_MOD_CHANNEL_ID` | unset | Text channel pinged on reports (with mod action buttons) |
| `MARKETPLACE_MOD_ROLE_IDS` | unset → ManageGuild | Comma-separated role ids allowed to act on report pings |
| `FREE_ADOPTION_SLOTS` | 1 | Active adoptions per free account |
| `FREE_LISTING_SLOTS` | 2 | Live listings per free account |
| `ADOPTION_COOLDOWN_MS` | 43200000 (12h) | Re-adopt lockout after a drop |
| `MARKETPLACE_REPORT_FLAG_THRESHOLD` | 3 | Reports that auto-flag a listing |
| `MARKET_PUBLISH_DAILY_CAP` | 5 | New listings per creator per day |
| `MARKET_REPORT_DAILY_CAP` | 20 | Reports per user per day |
| `MARKET_ADOPT_DAILY_CAP` | 20 | Adoptions per user per day |
| `MARKET_NEW_TAG_DAYS` | 7 | How long a fresh listing keeps the `New` tag |
| `MARKET_TOP_RATING_AVG` | 4.5 | `Top Rated` minimum average |
| `MARKET_TOP_RATING_MIN` | 5 | `Top Rated` minimum rating count |
| `MARKET_TRENDING_COUNT` | 5 | `Trending` adoptions inside the window |
| `MARKET_TRENDING_WINDOW_H` | 72 | `Trending` window in hours |
| `SAFETY_MODEL` | `GROQ_MODEL` | Classifier model for listing/reply screens |

Bot needs **Create Public Threads** (+ **Manage Threads** for clean archiving)
in the forum channel.

## Known rough edges / next-phase candidates

- Republish/relist posts a new thread rather than editing — a popular
  listing's comments don't carry over. A *flagged* republish saves the edits
  but skips the fresh thread entirely.
- Roster pickers show at most 5 companions — accounts with more can't reach
  the tail from the picker (command paths still work).
- Deleting a listing *row* (only possible via SQL today) orphans its adopted
  clone `companions` rows — `adopted_from_listing_id` deliberately has no FK
  yet; hard removal of clones is a moderation-phase decision.
- Flagged listings keep their thread visible (Adds are blocked at the button);
  auto-archiving on flag is a small change if wanted.
- Delisting is soft by design; `banned` freezes clones but keeps the rows —
  hard removal of a listing's clone rows remains a later decision.
- The NSFW lane (verified-age, BYOK-only, separate forum) is deliberately
  deferred — its agreed shape is in docs/moderation.md.
