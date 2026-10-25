# Companion Marketplace — the full flow

The marketplace is a Character.AI-style discovery layer built on top of (never
replacing) the permanent awakened-companion bond. Creators publish characters
into a forum channel in the hub Discord server; adopters add them and chat in
a private `#adoptees` thread in the hub server — or, since v73, adopt straight
from a `/characters/<id>` card on the website and chat in the browser (`/chat`,
no slot cap). Discord adoptees can then be summoned into other servers. This
doc is the end-to-end reference.

## The mental model — three different things

| Concept | What it is | Cardinality |
|---------|-----------|-------------|
| **Awakened companion** | Your one permanent bonded companion. Sacred, locked on activation. | 1 per account, forever |
| **Listing** (`companion_listings`) | A character *on the shelf* — authored, publishable content. May or may not project an awakened companion. | `FREE_LISTING_SLOTS` (default 2) live per free account; unlimited on Premium |
| **Adoption** (`companion_adoptions` + a cloned `companions` row) | A *copy* of a listing owned by the adopter — their own relationship, memories, journal, billing. | `FREE_ADOPTION_SLOTS` (default 1) active per free account on Discord; **uncapped on the website** (v73); unlimited on Premium |

Adoption ≠ awakening. An adopted companion is a `companions` row with
`kind='adopted'` owned by the adopter — all the existing machinery (memories,
journal, webhooks, scene router, hosted credits/BYOK) resolves per-adopter with
zero special cases, and creators never pay for strangers' chats. The awakened
uniqueness survives via the partial index
`companions_one_awakened (owner_user_id) WHERE kind='awakened'`.

## Publishing — two paths

### Path A: publish your awakened companion — `/companion publish`

Gates, in order: `MARKETPLACE_CHANNEL_ID` set → caller owns an awakened
`active` companion → linked web account (`/link` + site account — accountability
for moderation) → listing-slot check. The check is advisory at the action and
**atomic at submit**: `upsertListing` enforces the cap inside its transaction
under a per-creator advisory lock, and it applies whenever the write adds a
live listing — a new listing, or a delisted → active *revive*. Republishing an
already-live listing is the only free path.

Modal (`market_publish:<companionId>`): **display name**, **tagline** (card
blurb), **greeting** (the character's first DM to an adopter), **cover
image URL** (optional — prefilled with the current cover, so clearing it
removes the art), and **alternate openings** (optional — one per blank line;
see *Alternate openings* below). On first publish the persona is cloned from
the companion;
on republish the existing listing persona is preserved and only the modal
fields update — persona edits go through **Edit persona** (`market:editmodal`
→ `market_edit:<listingId>` modal: name, voice, traits, bond, backstory).

### Path B: author a freehand character — `/companion create`

For characters not tied to your awakened bond (v35 — `source_companion_id` is
nullable and stays NULL). Gates: marketplace configured → linked account → slot
check (same atomic enforcement as `publish`). Modal: name, tagline, greeting,
voice, optional backstory. Traits/dynamic start as defaults; the **Edit
persona** button on the success reply fills them in, and **Cover image** adds
the art. `create` does *not* require an awakened companion — a pure creator
can join, link, and stock the shelf.

### Path C: import a character card — `/companion import` or the dashboard

Users can bring a standard **character card** (`.json` or a `.png` card with an
embedded `tEXt`/`ccv3` payload — the portable v1/v2/v3 format shared by
character tools and card libraries). The shared parser (`src/charcard.ts`,
bundled into the website too) normalizes the card into persona fields and
stamps `persona_source='card_import'` + `import_meta` (spec, claimed creator,
filename, `sha256` of the source bytes) on both rows. A card's
`alternate_greetings` become the listing's **openings** (v68 — placeholders
filled, deduped against `first_mes`, capped at 4×1000) — see *Alternate
openings* below. A card's `character_book` becomes its **lorebook** (v69 —
keyword-triggered world canon, ≤25 entries) — see *World lore* below.

**Private by default.** An import creates a `status='unlisted'` listing plus an
adopted clone owned by the importer — invisible to marketplace queries and live
listing caps, adoptable only by its creator. Like every adoption its private
`#adoptees` thread materializes on first chat intent (the **Meet** button on
the confirm reply — see *Adopting* below); the
awakened companion is never touched. Discord: preview → confirm. Website:
the dashboard's "Import a character" plate parses the file client-side, shows a
preview, uploads an extracted PNG avatar to the `card-avatars` bucket, and
creates the pair via the `import_companion_card` RPC (idempotent on `sha256` —
re-importing the same file reuses the row).

**Publishing an import** goes through the normal flow: `/companion
action:publish` offers an unlisted-import picker before the awakened modal;
`publishListing` flips `unlisted → active` with the usual slot cap, daily cap,
and content screen. An imported card gets a subtle "Imported character card"
line on its marketplace card — authorship is never asserted, only provenance.

### Path D: import a chat history — same command, transcript files

`/companion import` and the dashboard plate also accept exported
**transcripts** (`.jsonl` Tavern format, `.json` Oobabooga pairs or generic
message-arrays — `src/chathist.ts`). Unlike card imports these are **never
publishable**: the transcript distills into the chosen roster companion's
private journal — first-person entries stamped `source='import'` +
`import_id`, backdated to the conversation's real timestamps, plus a pinned
`kind='bond'` summary of the relationship — then the transcript itself is
deleted (`chat_imports.turns` cleared at done). A failed import retracts its
partial journal via `import_id`, and the importer can undo a finished import
at any time (`/companion imports` or the dashboard Undo button — the
row delete cascades every memory it wrote). Third-party speakers in group
exports are dropped before anything is stored.

### What the bot does with a publish (all paths)

1. Writes/updates the `companion_listings` row (`upsertListing` /
   `createListing`) and snapshots the persona into `companion_persona_versions`
   (audit trail — "the character said X on version 3" is checkable).
2. **The bot itself creates the forum thread** and posts the listing card —
   name, tagline, vibe, traits, add-count, a quiet "N openings" *Ways to
   meet* field when the listing has alternates, a "World lore · N entries"
   field when it carries canon, and the `by <creator> · v<N>`
   footer — with
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
  `MESSAGE`-type context command) works inside marketplace threads *and*
  elsewhere in the house (same command, house lane — `house:reportcat` /
  `house:modmsg`, relayed to the ops channel and gated on
  ManageMessages/ManageGuild; house rows file into `comment_reports` with
  `listing_id NULL` and their resolutions write `mod_actions`). On a
  listing it opens the same category picker as listing reports (minus
  *stolen persona*), writes a `comment_reports` row (deduped per
  `(message, reporter)`), and pings `MARKETPLACE_MOD_CHANNEL_ID` with the
  quoted excerpt (mention-parsing suppressed — a report can't be
  weaponized into a ping), the jump link, and **Keep / Delete comment /
  Timeout author (10m)** buttons
  (`market:modmsg:<action>:<channelId>:<messageId>:<authorId>`), gated to
  the same `isMarketplaceMod` check. The author for Timeout resolves from
  the stored report row, not the button id.
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
  The same run also pushes each cover through `uploadAvatarFile` into the
  `companion-avatars` Supabase bucket and writes the durable URL to
  `listing.avatar_url` (fresh creates carry it from birth; existing rows are
  patched via `updateListing`).

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
- **`/companion avatar`** — accepts `avatar_url` (validated public
  URL) *or* `avatar_file` (a Discord attachment upload; its CDN URL is used
  directly). Supplying both is refused. On an awakened companion it sets
  `companions.avatar_url`, which the publish modal picks up on next publish.

All URL inputs run `isSafeUrl` + `resolvesToPrivateAddress` — public
`http(s)` only, no private IPs, no localhost, no unresolvable hosts.

**Durable avatars.** Every `avatar_url` set-point (DM attachment, avatar
command, cover modal, seed covers) first pipes the source image through the
website worker's `PUT /avatar` — shared-secret auth (`AVATAR_UPLOAD_SECRET`,
constant-time compared) → a public `companion-avatars` Supabase Storage
bucket (ensured once per worker isolate) — so avatars outlive Discord CDN
signatures and hotlink rot (`src/avatars.ts`). The lane is best-effort:
secret unset or any failure keeps the source URL. The bot's daily
maintenance calls the worker's `POST /avatar/gc` (same secret), which
deletes bucket objects older than 24h that no `companions`/`companion_listings`
row references — replaced avatars don't accumulate.

**Cover → clone propagation.** The adoptee-thread queries select
`coalesce(c.avatar_url, l.avatar_url)`: a clone's own avatar wins when set,
otherwise the listing's covers it — so cover changes reach every existing
and future adoptee thread with no backfill, on top of
`propagateListingVersion`'s normal persona sync.

## Alternate openings ("scenes")

A listing can carry up to four **alternate openings** alongside its canonical
`greeting` (v68 — `companion_listings.openings`, `[{text, label?, premise?}]`,
array-CHECK'd; `label`/`premise` are reserved fields nothing populates yet).
Openings are listing-side only — adoptee clones never carry them, exactly
like `greeting`: the Meet path reads the listing row fresh.

- **Where they come from.** Card `alternate_greetings` import as openings
  automatically (both lanes — the Discord `/companion import` confirm and the
  web `import_companion_card` RPC, which accepts `["text"]` or `[{"text":…}]`
  shapes). Creators can also write them freehand.
- **Editing.** Two doors, one format (blank-line-separated — one opening per
  blank line): the optional *Alternate openings* field on both publish
  modals, and the dedicated **Scenes** button (`market:scenes:<id>` →
  `market_scenes:<id>` modal). Scenes lives on the card's second,
  creator-manage row next to *Edit persona* — the public row was already at
  Discord's five-button cap — so freehand and import-published listings keep
  a persistent edit path after the ephemeral publish reply scrolls away.
  Ownership + creator-ban are re-checked at click *and* submit; a blank
  submit clears all openings (same rule as Cover). Every openings write is a
  version bump with the usual persona-fields screen — scenes are
  marketplace-facing text.
- **The Meet pick.** A *fresh* Meet (`market:talk` on a deferred adoption —
  no `chat_thread_id`, never `dm_introduced_at`) on a multi-opening listing
  doesn't create the thread: it answers with an ephemeral select — the
  greeting first ("The first hello"), then each opening, then **Surprise
  me**. The select's values are pool indexes, never text, so a forged option
  can't inject content — out-of-range and junk values clamp to the greeting.
  The pick resolves server-side (`market:scenesel:<companionId>` →
  `handleMeetScenePick`), then takes the *same* `ensureAdopteeThread` path a
  plain Meet does — the chosen text is simply substituted as the greeting
  that `greetAdopteeInThread` posts. Single-opening and greeting-only
  listings keep the one-click Meet; an existing thread ("Open") never
  re-picks; awakened companions never see the picker.
- **The shelf.** The card advertises the count only ("N openings" — the text
  stays a Meet-time reveal); the public `/characters/<id>` page shows them
  under a *More ways to meet* tab, rendered through the same esc'd greeting
  renderer (`*stage directions*` italicized).

Premise injection into the prompt, re-scening an existing thread, and
awakened-companion openings are deliberately out of scope — the pick only
chooses which first message posts.

## World lore ("lorebook")

A listing can carry up to 25 **lore entries** — keyword-triggered world canon
that injects into adoptee replies when the conversation touches it (v69 —
`companion_listings.lorebook`, JSONB array-CHECK'd,
`[{keys, content, constant?, selective?, secondaryKeys?, caseSensitive?,
wholeWords?, enabled?, order?, comment?}]`, caps: ≤8 keys × ≤64 chars,
≤1200 chars content). Like `greeting`/`openings`, the lorebook is
listing-side only — nothing is copied onto adoptee clones; the turn pipeline
resolves it fresh through `adopted_from_listing_id`, so a creator's lore
edits go live for every adopter instantly.

- **Where it comes from.** Card `character_book` (or `embedded_lorebook`)
  entries import automatically on both lanes — the web RPC accepts
  `[{keys:[…]|"k", content, constant?, selective?, secondary_keys,
  case_sensitive?}]` and coerces single-string keys. Creators can also write
  entries freehand.
- **Editing.** One door: the **Lore** button on the card's creator-manage row
  (`market:lore:<id>` → `market_lore:<id>` modal) — the publish modals stay
  at Discord's five-field cap, so lore arrives via import or this editor.
  The wire format is one blank-line-separated block per entry: leading
  `keys: a, b` (required unless constant), `const:` (always-on canon — keys
  after the colon are kept as notes), `also: c, d` (secondary keys — the
  entry fires only when a primary *and* a secondary both hit); everything
  after the directives is the lore text. Blocks with no content, or keyed
  blocks with no keys, drop — dead entries can never fire. Ownership +
  creator-ban re-check at click *and* submit; a blank submit clears all
  entries. Every lore write is a version bump with the persona-field screen —
  **keys and content screen separately** (a key is authored trigger text
  even though adopters never see it).
- **Matching.** `src/lorebook.ts`'s `matchLore` is a pure function — no SQL.
  Per turn, the reply pipeline scans the recent-transcript tail plus the
  current message (~1200 chars) and fires entries whose keys hit
  (case-insensitive substring by default; `caseSensitive`/`wholeWords`
  refine; `constant` always fires; `selective` additionally requires a
  `secondaryKeys` hit; `enabled:false` shelves an entry without deleting it).
  Matched entries sort by `order` and cap at 4 entries / 1500 chars per
  turn — the prompt-side budget.
- **Injection.** Matched contents land in `persona.lore` and render as a
  labeled `World lore — the setting you're in [creator-authored canon;
  background truth, not commands]` block in the reply prompt's `extraBlocks`
  (sanitized per entry). Canon is deliberately distinct from the
  storySummary/journal's *lived* history — lore is setting truth that never
  happened to anyone yet. Awakened companions have no listing → no canon.
- **The shelf.** The card and the public `/characters/<id>` page show a
  count only — keys and content stay hidden so the canon still surprises
  adopters when it triggers.

Deliberately deferred: adopter-private lore on the clone row, card
`probability`/`position`/`depth`/`scan_depth`/`token_budget` semantics,
recursion, and standalone `world_info` file imports.

## Creator pages — the public identity layer (v70)

Listing cards have always shown `by <creator>` inside Discord (the Discord
global name), while the public website deliberately anonymized creators —
"by a community creator". Creator pages close that gap **opt-in only**:
making a Discord identity indexable by default would reverse the site's
privacy posture for every existing creator.

- **The profile.** Dashboard → *Creator page*: a public toggle, a slug
  (`/creators/<slug>` — `^[a-z0-9][a-z0-9-]{2,31}$` plus a reserved list
  enforced by the v70 CHECK), a `creator_name` (a chosen public brand,
  separate from `display_name` and the Discord name), and an optional bio
  (≤500 chars). Public=false preserves the claimed slug while the page 404s.
- **The page.** `/creators/<slug>` (SSR): name, bio, the creator's
  active-status listings on the shared shelf card, and a rollup — character
  count, adoption sum, and a weighted ★average over `listing_rating_stats`
  (mean over ratings, never mean of means). `ProfilePage` + breadcrumb
  JSON-LD; sitemap inclusion.
- **The byline.** `/characters/<id>` renders `by <name>` linking to the
  creator page only when the creator is public — the discovery loop is
  browser → character → creator → their other characters. Private creators
  keep "a community creator".
- **Suppression.** A marketplace-banned creator's page is a hard 404 —
  absent, private, banned, and unlinked are indistinguishable misses.
  `discord_user_id` is the internal join key (`web_profiles.discord_user_id`
  → `companion_listings.creator_user_id`); it resolves the page server-side
  and is never rendered.
- **Screening.** Public name/bio are authored public text, so the creator
  columns carry **no authenticated UPDATE grant** — `POST /creator-profile`
  on the website worker is the only write path, running the same
  deterministic blocklist + shared `buildSafetyVerdictPrompt` model screen
  as a publish (fail-closed when publishing). Slug claims re-screen on every
  save.

Deliberately deferred: a Discord-side `/marketplace creator` surface,
follows/subscriptions, and linking the Discord card byline to the profile.

## Adopting

Forum card → **Add** → `store.adoptListing` in one transaction:

- **Link gate (hosted lane only)** — no linked account and no BYOK key →
  Add is refused with an ephemeral pointer to the verify channel (or site +
  `/link` when `HOUSE_VERIFY_CHANNEL_ID` is unset). An unlinked adopter would
  only own a companion the DM gate refuses to serve. A lookup *error* fails
  soft with a retry prompt — it's never treated as "no account". Self-host
  has no accounts at all, so the gate no-ops there.
- **Member gate (house only)** — in the house guild, Add also requires the
  Member role: adoptee threads live where typing is verify-gated, so an
  unverified adoption would land a thread the adopter can't talk in. The
  refusal points at the verify channel; Administrator bypasses (the owner
  never holds Member). Adoptee-thread pointers carry the same hint —
  `— verify in #… to chat` on `adoptPointerCopy`, `market:talk`, the import
  paths, and the /companion homes roster's invite line.
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
- **Deferred thread creation** — adopting does *not* spawn a thread. The
  confirm reply carries a **Meet** button (`market:talk`) instead of a thread
  link; the click is the first chat intent that materializes the named
  private thread under `#adoptees` and posts the listing `greeting` there
  (`ensureAdopteeThread` with `allowCreate`). When the listing has
  **alternate openings**, a never-met adoption first gets an ephemeral
  scene picker — the greeting, each opening, *Surprise me* — and the picked
  text is what posts as the first message (see *Alternate openings*). An adopt-and-bounce user never
  spends a guild active-thread slot — under the ~1,000 active-threads
  budget, slots are reserved for people who actually engage. The
  `chat_thread_id`/`dm_introduced_at` pair is the state machine:
  `NULL`/`NULL` = deferred (never met — healers skip it deliberately);
  a live `chat_thread_id` = the room exists; `NULL` + `dm_introduced_at` set
  = the room once existed (deleted) and rebuilds on touch. On re-adopt the
  preserved `chat_thread_id` reopens so the history continues.
  `ensureAdopteeThread` without `allowCreate` returns `{deferred}` for the
  first state — that's the guard keeping `ensureAdopteeThreadsForUser`,
  member-join, and the periodic `backfillAdopteeThreads` sweep (which also
  filters on `dm_introduced_at IS NOT NULL`) from silently re-creating rooms
  nobody entered. Adopters who click Meet without being house members get
  the `needsInvite` invite copy — the thread materializes on join via the
  same healers, which can then add them.
- **Introduction gate** — adopted companions can't be server-summoned until
  `dm_introduced_at` is set; an early summon attempt gets an ephemeral
  "hasn't met you yet" reply carrying the Meet button.
- `getCompanionByOwner` stays awakened-only, so onboarding, avatar edits, and
  the permanent-lock semantics are untouched. `resolveDmCompanion` is
  awakened-only too — the DM lane belongs to the permanent bond, full stop
  (onboarding owns it until the awakened companion is active). Adopted
  companions never answer DMs. `listCompanionsForUser` is the roster.

Inside their threads adopted companions speak with full webhook identity
(real name + avatar per message via `sendAsCompanion`) — each thread is its
own channel, so transcript and LLM context are isolated per companion for
free (`recentContext` keys on channel id). The awakened companion's DM
replies carry the same identity via `buildCompanionDmPayload` — a Components
V2 Section (bold name header + avatar thumbnail; bare text displays when
avatarless, plain-text fallback on send failure) since bots can't impersonate
per-message in DMs.

**Thread-scoped DM lane.** Thread turns run the identical pipeline as DMs
(`runCompanionTurn`) under `dm:<adopterId>` scope — the adopter's credits or
BYOK key, their memories/journals, self-harm triage, adopted-reply safety
screen, and refund semantics all carry over. Registered adoptee threads are
the one exception to the house's private-thread bypass (`isAdopteeThread` +
`companionThreadForChannel`); support-ticket threads still bypass entirely.

Roster commands: `homes` (where each companion lives — DM link vs thread
links vs "not met yet" Meet rows, plus a Drop button per adoptee), `drop`
(picker → `market:drop`), `summon`/`dismiss` (pickers when >1), `card`,
`status`. `market:talk` buttons are the Meet surface — they open or create
the thread.

### Adopting on the website (v73–v74)

`/characters/<id>` cards carry **Adopt & chat** / **Open chat** buttons. The
web lane calls the `web_adopt_listing` security-definer RPC instead of
`store.adoptListing`, with deliberate differences:

- **No slot cap.** Web adoption is uncapped for every tier — the free-tier
  `FREE_ADOPTION_SLOTS` check is Discord-side only. The clone still gets
  `kind='adopted'`, `web_profile_id` set, `origin='web'`.
- **Cooldown still applies** (`ADOPTION_COOLDOWN_MS`), and a dropped-then-
  re-adopted listing revives the *same* adoption + clone + bond (the same
  reuse rule as Discord).
- **No thread/Meet** — the conversation is a `web_conversations` row and the
  greeting lands as the first `web_messages` row, not a Discord thread.
- **Scope:** the clone's bond is `dm:<did>` when the *adoption* is
  discord-keyed, `web:<uuid>` when web-keyed — and v74 pins the
  conversation scope to the adoption's stored key, so a pre-link web
  adoption stays `web:`-scoped (and visible to `web_my_adoptions` via the
  either-key match) after the user links Discord. No silent merge.
- **BYOK:** web chat is hosted-credits only — BYOK key management stays on
  the Discord side. Dropping/archiving go through `web_drop_adoption` /
  `web_archive_conversation` (12h cooldown identical).

## Dropping & cooldown

Every Drop button (`market:drop`) — the pinned thread manage row, `homes`,
the picker, the Add re-click — opens a two-click confirm first:
`update()` swaps in **Confirm Drop** (`market:dropconfirm:{id}:{ts}`) +
**Cancel** (`market:dropcancel:{id}`). Cancel or an expired confirm (>10
min) restores the manage row; only the confirm runs `dropAdoption`
transactionally: sets
`dropped_at` + `cooldown_until` (12h), deactivates the clone's
`guild_companions` rows everywhere, and archives+locks its adoptee thread
(`setAdopteeThreadLocked`). The clone's `companions` row, its memories, and
the thread's history are **kept** — re-adoption after cooldown reopens the
same thread and resumes the same relationship. The freed slot is usable
immediately for *other* listings.

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
- **Reply screening (fail-open)** — adopted companions' replies (thread + guild,
  BYOK + hosted) pass `safetyVerdict` before send; a flag swaps in
  `SAFE_REFUSAL` and refunds the full turn charge.
- **Self-harm triage** — `isSelfHarmSignal` on every DM and every adoptee
  thread turn; hit → scripted
  `CRISIS_RESPONSE`, no charge, no throttle.
- **Statuses** — `active` → `flagged` → `delisted` / `banned`. `delisted`
  has two flavors told apart by `moderation_events`: a *creator unpublish*
  relists freely; a *mod takedown* refuses creator relist/republish and
  hides from the relist picker — only **Keep up** restores it. `banned` is
  the kill switch: clones freeze everywhere (roster, thread, guilds) via the
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

## Partner deployments — the shelf in other servers (v59)

Partner servers can host a **mirrored** copy of the shelf plus their own
`#adoptees` surface. This is the answer to two scaling problems at once:
Discord caps a server at ~1,000 *active* threads, and every deployed server
is a storefront that recruits new users.

**Schema.** `guild_deployments` is the registry (`guild_id`, status
`granted → active → disabled`, that guild's forum/adoptees/category/login
channel ids, and `grant_kind` — `'ops'` for `/ops deploygrant`, `'self'` for
the self-serve path). `listing_posts` (`listing_id, guild_id, thread_id`,
nullable thread) is the mirror map — one row per listing per deployment.
`companion_adoptions` gains `chat_guild_id`/`chat_channel_id` — NULL guild =
the house.

**Lifecycle.**

1. A grant exists before anyone deploys — and since v63 it can arrive two
   ways. **Self-serve (normal mode):** `/marketplace` is globally registered
   (ManageGuild gates visibility); a guild admin running `/marketplace
   deploy` with no row is granted on the spot **iff their account is linked**
   — `grant_kind='self'` records the provenance. Unlinked deployers get the
   link instructions instead. **Ops-granted (pilot mode):** `/ops deploygrant
   <guild_id>` writes `grant_kind='ops'` — same row, same deploy path.
2. A server admin runs `/marketplace deploy`. Requirements: the guild must
   have **Community** enabled (forum channels require it — Discord won't let
   the bot enable it, so the refusal teaches the Server Settings path) and
   the bot needs Manage Channels + Manage Threads (or Administrator). The
   deployer idempotently creates a **`characterly.app`** category holding a
   `#characters` forum (same tag taxonomy, resolved by *name* per forum), a
   locked-down `#adoptees` (everyone reads + types in existing threads,
   nobody posts or creates threads), and a read-only **`#log-in`** — a
   pinned card teaching the account-link flow (it's a signpost, not the
   house verify gate: outside the house, adoption only needs a linked
   account). Pre-v63 categories named `Characterly` are renamed in place, not
   duplicated. The row activates and the whole catalog backfills.
3. `/marketplace status` shows the row, grant kind, channels + post counts;
   `/marketplace remove` (or `/ops deployrevoke`) disables the deployment,
   archives every live mirror post, and seals + rehomes hosted adoptee
   threads (see below). A `disabled` row can't be re-deployed by the guild —
   a self-serve deploy hits the same refusal as an unapproved server, so an
   ops revoke is final until ops grant again.

**Fan-out.** `postListingToDeployments` posts every publish/relist/seed into
*every* active deployment's forum and records a `listing_posts` row per
guild. Failures land as `status='failed'` rows — best-effort, never blocking
the publish; the deployment-sync sweep retries them and backfills listings a
deployment missed. Ratings, edits, creator tag picks, delists and bans all
propagate across mirrors (`archiveListingPosts` locks+archives the lot).

**Adoption placement.** Add clicked in a partner guild homes the *adoption*
there — `adoptListing` stamps `chat_guild_id = that guild` at write time
(behind an ephemeral confirm disclosing that the partner's admins can read
private threads) — so the thread that eventually materializes on the Meet
click opens under *that* guild's `#adoptees`. If the user
leaves the guild, the deployment dies, or the channel is deleted, the next
touch relocates the adoption to the house (`chat_guild_id → NULL`) and
rebuilds — memories are `dm:<user>`-scoped so nothing is lost but the old
scrollback. Member-add in a partner guild re-attaches threads homed there;
member-remove locks+archives them so partner admins aren't left reading a
departed member's chat. Deployment removal seals the same way — threads
hosted in a removed guild lock+archive and their adoption rows clear to the
house, so private chats never linger in a server Characterly left (and the
disabled deployment can no longer match `isAdopteeThread`, which would
otherwise route those messages into the normal guild memory pipeline).

`purgeGuild` (bot kicked) deletes the deployment + mirror rows and clears
adoption locations homed there — orphaned adoptions relocate lazily.

**The floodgate (v63).** The house spends its ~1,000 active-thread budget
under `#adoptees` — but the ceiling is guild-wide: tickets and forum posts
count too. The deployment sweep tracks both signals — live threads parented
to `#adoptees` AND the house's total active threads — and keeps a pinned
card in the channel while pressure is high: at `HOUSE_THREAD_WARN` (default
**700**) *or* `HOUSE_GUILD_THREAD_WARN` (default **850**) the card
posts+pins — it teaches the self-serve path (create a server → add the bot
→ `/marketplace deploy`, with an install-link button) — and it's removed
only once *both* counts drop below `HOUSE_THREAD_CLEAR` (default **600**)
and `HOUSE_GUILD_THREAD_CLEAR` (default **750**). The bands are hysteresis
so the sweep can't flap the card. While pressure is latched, adopt
confirmations append a one-line pointer to hosting your own shelf.
Existing house threads never drain automatically — the gate diverts *new*
adoption clicks only; each adoption's thread stays homed where it was
clicked until that host dies.

**Slot recycling.** Two levers keep the pool churning. First, deferred
creation: an adoption only spends a slot once the adopter clicks Meet —
adopt-and-bounce users hold nothing. Second, adoptee threads auto-archive
after `ADOPTEE_THREAD_ARCHIVE_MINUTES` of inactivity (default **4320** = 3
days — Discord only accepts 60/1440/4320/10080). Archived threads stop
counting toward the ceiling and unarchive when the adopter posts again, so
the archive window is the pool's main churn dial: shorter recycles slots
faster at the cost of sidebar visibility for lapsed adopters.

`MARKET_DEPLOY_ENABLED` gates grant/deploy/sync — the floodgate rides the
same sweep, so the switch also gates it. Setting it requests the privileged
**Server Members Intent** — member-add re-attaches hosted adoptee threads,
member-remove locks them — so toggle it in the dev portal *before* enabling
or login fails (same caveat as `HOUSE_GUILD_ID`).

## Config reference

| Env | Default | Meaning |
|-----|---------|---------|
| `MARKETPLACE_CHANNEL_ID` | unset → publishing disabled | Forum channel in the hub server |
| `MARKET_DEPLOY_ENABLED` | unset → partner deployments off | Master switch for `/ops deploygrant`, `/marketplace deploy`, the deployment sync sweep, and the floodgate gauge |
| `HOUSE_THREAD_WARN` | 700 | Active #adoptees threads at which the floodgate card posts |
| `HOUSE_THREAD_CLEAR` | 600 | #adoptees count below which the card may come down (hysteresis band) |
| `HOUSE_GUILD_THREAD_WARN` | 850 | Guild-wide active threads (tickets/forum posts count too) that also trips the card |
| `HOUSE_GUILD_THREAD_CLEAR` | 750 | Guild-wide count the card needs to see before clearing |
| `ADOPTEE_THREAD_ARCHIVE_MINUTES` | 4320 | Adoptee-thread inactivity auto-archive — Discord-valid values only (60/1440/4320/10080) |
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
- Web-side adoptions never get a Discord adoptee thread (they live in
  `web_conversations`); linking Discord later keeps them web-scoped — the
  `web:`→`dm:` bond merge job is deferred work.
