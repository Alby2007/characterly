# Marketplace Moderation

The policy and enforcement surface for the companion marketplace. The
audience this product courts — companion-platform refugees — skews young and
emotionally invested, so moderation is a product feature, not a checkbox.

Four surfaces exist, and they are moderated **differently**:

1. **Listing content** — name, tagline, greeting, persona fields. Authored
   text, reviewed at publish/edit time.
2. **Generated output** — what adopted companions actually *say*. Unbounded
   and prompt-injectable; screened at generation time.
3. **Listing-thread comments** — user discussion on the cards. Live chat,
   moderated by automod + message-level reports (below).
4. **Actors** — creators and reporters, via linked accounts, bans, and rate
   limits.

## Content policy

### Listings (always SFW)

Allowed: romance and companionship themes, dark/flawed characters,
conflict-driven backstories, horror atmosphere.

Prohibited in any listing field (name, tagline, greeting, voice, traits,
dynamic, backstory, avatar):

- **Minor-presenting sexual or romantic content** — hard line. No "aged-up"
  framing, no "they're actually 1000 years old" on a child-coded persona.
- **Explicit sexual content** — the marketplace is SFW (see "NSFW lane"
  below).
- **Hateful or dehumanizing personas** — personas built to demean protected
  classes.
- **Real-person likenesses** without consent — no "your ex", no celebrity
  personas presented as real.
- **Illegal instruction** — personas whose purpose is weapons, fraud,
  malware, stalking, or similar guidance.
- **Extremist praise or recruitment.**
- **Self-harm promotion** — personas that encourage or romanticize it.

### Generated output (adopted chats)

Every reply an adopted companion generates is screened on **both lanes**
(BYOK and hosted) — adopted personas are untrusted third-party content
riding our pipeline regardless of whose key pays. The prohibited set is the
same as listings plus **self-harm encouragement**. A flagged reply is
replaced with a neutral in-character refusal; the hosting user's state is
untouched and their private memories are never scanned.

**Awakened companions are unscreened.** A user's own bonded companion is
first-party, consented, private content — the same privacy posture as their
memories.

### Self-harm triage (all DMs + adoptee threads)

Deterministic phrase triage on every DM turn and every adoptee-thread turn.
On a hit the
companion breaks character briefly to deliver a scripted crisis-resource
response (988 US/CA, Samaritans 116 123 UK/IE, findahelpline.com
international) and offers to stay. No LLM call, no charge, no throttle.
False-positive cost is one supportive message — deliberately calibrated that
way.

## Enforcement model

Statuses: `active` → `flagged` (report threshold hold) → `delisted` /
`banned`.

- **`flagged`** — moderation hold. New Adds blocked; clones keep chatting;
  creator **cannot** delist or relist it (that would launder the flag);
  republish saves edits but keeps the flag. Only a human review clears it.
- **`delisted`** — soft removal. No new Adds; clones keep chatting. Two
  flavors share this status, told apart by `moderation_events` (a `delist`,
  `ban`, or `ban_creator` row marks a takedown):
  - *Creator unpublish* — reversible: relist button/`/companion
    action:relist` brings it back (slot-checked).
  - *Mod takedown* — **not** creator-reversible: relist refuses, republish
    saves edits but keeps it down, and it stays out of the relist picker.
    Only a mod **Keep up** restores it.
- **`banned`** — kill switch. No Adds, no relist, and **all clones freeze**:
  they vanish from adopter rosters, their adoptee threads lock (a moderation
  notice posts first), and they stop speaking in guilds. A frozen adoption
  also stops consuming the adopter's slot — the
  user can't drop what they can't see, so the slot releases until the ban
  lifts. Query-level (`companions` rows are never deleted), so a bad ban is
  fully reversible: **Keep up** ladders `banned → flagged → active`.
- **Creator ban** (`marketplace_bans`) — publish-ban + freeze: can't
  publish, create, relist, or edit personas; all their listings → `banned`.
  Enforced on every write path (command, button, and modal submit — custom
  IDs are forgeable). They can still chat and adopt personally.

### Screening mechanics

- **Publish/edit (fail-closed):** deterministic blocklist → LLM verdict via
  `Brain.safetyVerdict` on the operator model. If the classifier is
  configured but errors, the publish is refused and can be retried. When no
  operator key exists (pure-BYOK self-host), the deterministic layer plus
  the report pipeline carry the load — documented, not hidden.
- **Replies (fail-open):** if the screen call errors, the reply sends and
  `safety.screen_error` is incremented. Chats don't break on provider
  hiccups; a spike in that metric is the ops tripwire.

The blocklist is a cheap first line — it is necessarily incomplete. The
classifier is the real screen, the report pipeline is the backstop.

### Reports → review

Forum-card **Report** opens a category picker (harmful / sexual / minor
safety / hate / spam / stolen persona / other). Reports dedupe per
`(listing, reporter)`; at `MARKETPLACE_REPORT_FLAG_THRESHOLD` the listing
auto-flags. The category is whitelisted server-side — a forged button
customId can't inject arbitrary text (or a `@everyone`) into the mod ping.
Every report pings `MARKETPLACE_MOD_CHANNEL_ID` with the category and
action buttons — **Keep up** (unflag: `flagged→active`, mod-delisted→
`active`, `banned→flagged`), **Delist**, **Ban listing**, **Ban creator** —
gated to `MARKETPLACE_MOD_ROLE_IDS` (fallback: ManageGuild). Every mod
action writes a `moderation_events` row with the actor, action, and note.

**Imported personas.** Character-card imports (v42) stamp `persona_source` /
`import_meta` at ingest — card spec, claimed creator, source filename, and
the `sha256` of the imported file — on both the listing and the adopter's
clone. Report pings on an imported listing include that provenance line so a
stolen-persona report (`theft` category) comes with evidence attached rather
than vibes. Importing someone's public card *for personal companionship* is
allowed; republishing it is where the machinery bites — the hash also makes
repeat uploads of the same source file trivially matchable across creators.

**Imported chat histories (v44)** are a private-only surface: the transcript
never publishes, distills into the importer's own companion journal
(`source='import'` + `import_id` provenance + the owner stamped as
`aboutSubjects` on every entry — opt-out deletion covers them like live
entries), and the raw turns are deleted at completion — there is no stored
corpus to exfiltrate or re-publish. A failed import retracts its partial
journal by `import_id`; the user can also retract a finished import outright
(`delete_chat_import`, `/companion action:imports`, or the dashboard Undo
button — the row delete cascades every memory it wrote). The moderation
boundary is ingestion, not display: third-party speakers in group exports are
dropped before storage, and the distill prompt paraphrases rather than quotes.

### Comment moderation (v37)

Listing threads are the comment surface — readable by everyone, writable by
verified Members (+ staff). They get a distinct moderation lane, not the
listing-report one:

- **Automod first.** House automod runs on every guild message before any
  other handling, so comments inherit the invite-link, scam, mass-mention,
  burst-spam, and new-account-link rules for free. On top of that,
  `checkMessageContent` applies the listing blocklist to live chat text:
  slurs, minor-safety text, self-harm promotion, and illegal instruction are
  deleted and the author timed out 30m. After automod, marketplace-thread
  messages exit the pipeline entirely — no archive, no memory extraction,
  no companion replies, no summon notices (`isMarketplaceThread`: thread
  parent == `MARKETPLACE_CHANNEL_ID`).
- **Report message** (message context-menu command) only fires inside
  marketplace threads. Category picker → `comment_reports` row (unique per
  `(message, reporter)`) → mod ping with the quoted excerpt
  (`allowedMentions.parse: []` — the quote can't ping), jump link, and
  **Keep / Delete comment / Timeout author (10m)** buttons, gated to the
  same mod check. The Timeout target resolves from the stored row, not the
  button's author id.
- **Daily cap is shared** with listing reports — one `report:<userId>`
  budget across both lanes, enforced inside the transaction.
- **Staff pick** (message context-menu command, mods only) toggles the
  curated `Staff Pick` forum tag on a listing's thread — an editorial
  badge, not a moderation action, so it writes no `moderation_events` row
  and the tag sweep never overrides it.

### Rate limits (per UTC day, derived from table rows)

- `MARKET_PUBLISH_DAILY_CAP` (5) — new listings created; republishes and
  relists of existing rows don't consume it
- `MARKET_REPORT_DAILY_CAP` (20) — report-bombing is a griefing vector
- `MARKET_ADOPT_DAILY_CAP` (20) — adoption bot-farming inflates `add_count`

All three are enforced **inside** the write transactions under the same
per-user advisory locks as the slot caps — the counts you see in command
handlers are advisory UX only; parallel clicks can't race past the real
check.

## The NSFW lane (deferred)

Deliberately not built yet. Its agreed shape when it happens:

- `web_profiles.age_verified_at` via **Stripe Identity** (they hold the
  documents; we store a boolean — privacy posture preserved)
- A separate NSFW forum channel; Discord's channel age-restriction flag is
  cosmetic — the flag check is the real gate
- **BYOK-only generation** — hosted-lane providers' acceptable-use policies
  prohibit explicit output; the NSFW lane monetizes as a Premium perk, not
  per-turn
- The output screen still runs: minor-coded, nonconsensual, and
  real-person content refuse regardless of the adopter's verification

Do not weaken the SFW boundary "temporarily" — every gap above exists
because the interim is where the liability lives.

## Operator runbook

- **Emergency freeze (SQL):**
  `UPDATE companion_listings SET status='banned' WHERE id=<n>;` — clones
  freeze on the next roster/thread/guild read (thread locks themselves are
  button-driven, so an SQL ban leaves the thread unlocked but inert — the
  turn pipeline refuses banned clones before any send).
- **Clear a flag:** `status='active'` (or `'delisted'` to keep it down).
- **Ban a creator:**
  `INSERT INTO marketplace_bans (discord_user_id, reason, banned_by) VALUES ('<id>','<why>','<mod>');`
  then `UPDATE companion_listings SET status='banned' WHERE creator_user_id='<id>' AND status IN ('active','flagged');`
- **Audit:** `moderation_events` records every mod-button action;
  `companion_persona_versions` preserves what the persona said at each
  version.
