# Characterly front end: rebuild spec

Status: **implemented in `web/`, not deployed** (2026-10-21). Visual direction "The Character Archive" (§2); finish review: ship. Cutover steps: `web/README.md`.

## 1. Context

The current site (`website/`: Vite multi-page vanilla HTML/JS, plus the worker-rendered shelf in `src/site-shelf.ts` with its own `public/shelf.css`) is being replaced, stack included. The owner's verdict is that it looks "vibe coded" and doesn't speak to the primary audience, Character.AI migrants (see `PRODUCT.md`).

The four rejected traits are binding anti-references:
- the stock dark/gold/italic-serif/mono-label "AI premium" look;
- ornament as costume;
- template page structure;
- literary copy.

The 2026-10-21 landing critique scored 22/32 (`.impeccable/critique/2026-10-21T09-32-25Z__website-index-html.md`).

**The site's job is unchanged:** persuade, link Discord, and be the back office for billing, memory and import. Discord is home. Nothing is adopted or chatted on the web.

**What the rebuild must achieve:**
1. A migrant understands within one screen that their characters remember them, in DMs and in servers, and that they can bring their existing character.
2. "Continue with Discord" is the obvious first action.
3. Every surface shares one visual system and one codebase.
4. Every current feature survives (Appendix A), and the inconsistencies the inventory found are fixed (Appendix B).

## 2. Visual direction: "The Character Archive"

Chosen 2026-10-21 in the Impeccable direction round (re-roll 1, assigned card; seed reference `seed:043c186d159d7264`). The first-viewport sketch the owner picked is `.impeccable/mocks/decision/archive.html`, and the build matches its arrangement, palette direction and density. The build is **code-led**: no image comp, and the ambition lives in this section.

**Thesis.** The site is built from the character archive screen of gacha-style games: a large character, a profile panel, and entries that unlock as you play. Each companion has an archive that fills in as they get to know you: memories appear, and every entry shows where it came from. (The game screen's bond level is not borrowed; the product has none.) It refuses the category default (search bar over a grid of identical character cards) and the old candlelit-study look.

**What it borrows and what it doesn't.** Only the collection and profile screens carry over. **No pulls, banners, odds, currencies-as-loot, rarity-for-sale, timers or "limited" urgency.** Tokens stay plain numbers. Colour that games use for rarity is used here only to encode real data (where a memory came from, plan state).

**Own world**
- **Ground:** a pale, cool field. A light world was chosen by the use scene: phone or laptop in the evening, beside Discord's dark UI. The site must read as a distinct place, not as more Discord.
- **Ink:** deep navy, not black.
- **Accents:**
  - one strong blue for DM-scoped, private things;
  - one pink for server-scoped things;
  - one warm gold reserved for the single primary action per view;
  - the starting values are the sketch's chips (`#f2f5ff`, `#14183a`, `#3d5bff`, `#ff5c8a`, `#ffb020`), tuned for contrast at build.
- **Form:** full-height character art against open field; a crisp archive panel with a tab row; flat surfaces; very few containers.
- **Type:** a heavy, tightly set display face for hooks and character names, and a clean workhorse UI face for panels. Both are chosen at build, outside Impeccable's default-face list.

**First viewport (landing)**
- **Left half:** a full-height companion portrait (Wren, first-party seed character, art per Appendix C; labelled as an example), with the hook "They remember you." set large over or against it.
- **Right half:** that companion's archive panel:
  - name and "Adopted · yours";
  - a "Remembers you since …" fact line (the Bond meter in the decision sketch was cut: the product has no bond level, and the page must not claim one);
  - tabs: Profile / What they remember / First hello;
  - 4–5 memory entries, each tagged YOUR DMS (blue) or #CHANNEL (pink), with the marks pinned, edited and forgotten (struck through).
- **Below the panel:** the primary action **Continue with Discord** (the gold button), with "Browse the shelf" and "Bring your character" as text links.

**Story.** The visitor sees a companion's archive about one person, works out that the memory is real, scoped and editable, and continues with Discord.

**Signature interaction.**
- The archive tabs work on the landing page.
- On the dashboard, the same archive is the user's real memory panel: pin, edit (strike-through plus rewrite) and forget (struck through, then removed).
- On the character pages, the archive layout presents the listing: portrait, profile tab, and first hello as the voice line.
- **Motion grammar:** one move, tabs that slide-and-settle. A memory entry "unlocks" (fades and lifts in) when added. Everything snaps under reduced motion.

**Rules raised from the declined challengers**
- **Charged emptiness:** one character per view, real negative space, no heads-up-display clutter around the portrait. (ikebana)
- **State is a mark, not a colour:** pinned, edited and forgotten have distinct glyphs or treatments that are legible in greyscale. (film cutting bench)
- **No boxes for grouping:** rank comes from scale and depth; keep panels few and flat. (cracktro)
- **Actions leave visible consequence:** forgetting strikes the entry through, then removes it; nothing vanishes silently. (leather skeuomorph)

**How it spans surfaces**
- **Shelf index:** a collection grid of portraits. Selecting one opens its archive page, which is the character page.
- **Account:** a single focused panel.
- **Dashboard:** your companions' archives (memory first), plus a plain account panel for tokens, billing and settings.
- **Legal pages:** plain reading panels in the same type and colour, with no game chrome.

**Honest risk.**
- It can read as an anime-game costume, or hint at gacha mechanics the product doesn't have. The no-mechanics rule above is binding.
- It depends on real character art. Listing avatars exist, but the landing portrait needs a first-party character's high-quality art (Wren, Appendix C).
- The Character.AI audience overlaps heavily with gacha players, which is the point and also the risk of feeling derivative.

Hard constraints (still apply):
- none of the four rejected traits;
- avoid Impeccable's list of training-data default typefaces (this includes the current Fraunces, Instrument Sans and IBM Plex);
- light or dark is chosen from the use scene (phone or laptop, evening, inside Discord), not by category;
- motion respects `prefers-reduced-motion`, and content is never hidden without JS.

DESIGN.md is rewritten at the end of the build from what actually shipped. It is not written ahead of it.

## 3. Stack and architecture

**Framework:** Astro 5 with `@astrojs/cloudflare`, `output: "server"` and per-route `prerender`. It deploys as the existing `characterly-website` worker on the same domains.

| Concern | Decision |
|---|---|
| Marketing, legal, guides | Prerendered (`export const prerender = true`). Legal pages render the root `TERMS.md`/`PRIVACY.md`/`SECURITY.md`/`SAFETY.md` **at build time** via Astro content collections or `import.meta.glob` (`?raw`) and one markdown pipeline. This fixes the empty-without-JS legal pages. |
| Shelf (`/characters`, `/characters/[id]`) | Server-rendered on the worker. The data layer is ported from `src/site-shelf.ts` (`fetchActiveListings`, `fetchListing`, `fetchRatingStats`, `fetchListingRating`, `relatedListings`) into `web/src/lib/shelf.ts`; templates become `.astro` pages. Keep the service-role PostgREST read, the `status=eq.active` filter, the degrade-to-empty behaviour and real 404s. Rendering through Astro escapes by default, and JSON-LD keeps the `</`→`<\/` guard. |
| `/sitemap.xml` | Server endpoint: the static paths plus live listings with `lastmod`. |
| Auth and dashboard | Prerendered shells with client islands in vanilla TS (no UI framework unless a direction needs one), reusing `website/src/auth.js`, `memories.js`, `import-card.js` and `import-history.js` logic, ported to TS modules under `web/src/lib/`. `@supabase/supabase-js` with the publishable key; RLS enforces access. |
| Worker endpoints | `POST /discord/events`, `PUT /avatar`, `POST /avatar/gc`, `POST /track` move to Astro API routes (`src/pages/discord/events.ts`, etc.) or a thin custom worker entry that hands everything else to Astro. Logic is ported verbatim from `website/worker.ts`, including the constant-time secret check and the `trackAe` blob layout. |
| Middleware | Astro middleware owns: canonical-host 301 (**exempting API paths**, to fix the POST→GET bug), security headers, `page_view` analytics. |
| CSP | Same policy, generated per response. If any inline script remains, its hash is computed at build time; prefer zero inline scripts. Add HSTS. |
| Shared code from the bot repo | `src/charcard.ts`, `src/chathist.ts` and `src/discord-events.ts` stay single-source and are imported across the boundary, as today. Document this; don't fork it. `DISCORD_INVITE` and `LINKS` get one source (`web/src/config.ts`), and the bot's `site-shelf.ts` is retired. |
| Fonts and assets | Self-hosted woff2 under `web/public/fonts`. One token stylesheet shared by every route; no second stylesheet for the shelf. |
| Analytics | Unchanged events and allowlist: `page_view`, `web_event` (`signup_start`, `signup_done`, `checkout_click`, `link_attempt`), `discord_event`, `avatar_upload`, `avatar_gc`. Add `discord_signin_click` to the allowlist for the new primary path. |

**Directory:** `web/` alongside `website/` until cutover.
- `web/astro.config.mjs`, `web/wrangler.jsonc` (or `cloudflare.config.ts` parity);
- `web/src/pages/`, `web/src/layouts/Base.astro`, `web/src/components/`;
- `web/src/lib/{supabase,auth,shelf,analytics,config}.ts`;
- `web/src/styles/tokens.css`.

## 4. Information architecture

**Global nav** is the same on every page:
- links: The shelf (`/characters`), How it works (`/#how`), Pricing (`/#pricing`), Safety (`/safety`);
- account slot: Sign in, or the user chip with Sign out;
- primary button: **Continue with Discord**.

On the dashboard, the button becomes **Open Discord**.

**Global footer:** Terms, Privacy, Security, Safety, the import guide, and "Add the bot to your server" (`LINKS.addToDiscord`, an admin link and not a page-level button).

| Route | Mode | Render | Indexed |
|---|---|---|---|
| `/` | Persuade | prerender | yes |
| `/characters` | Persuade | SSR (cache 60/300) | yes |
| `/characters/[id]` | Persuade | SSR (cache 60/300) | yes |
| `/guides/import-character-cards` | Read | prerender | yes |
| `/terms`, `/privacy`, `/security`, `/safety` | Read | prerender from `.md` | yes |
| `/account` | Operate | prerender + island | noindex |
| `/dashboard` | Operate | prerender + island | noindex |
| `/404` | — | prerender | noindex |
| `/sitemap.xml`, `/robots.txt` | — | endpoint / static | — |

**Primary path:** Continue with Discord → `signInWithOAuth` with `redirectTo: /dashboard?welcome=1` → consent gate if needed → dashboard first-run guide: **1** Discord linked (automatic via `sync_discord_identity`) → **2** Join the Characterly server (`LINKS.discord`) → **3** Adopt from `#characters` or import a card here.

**Fallbacks:**
- Email sign-up uses the `/link` code claim.
- Visitors who aren't ready can browse the shelf without an account.

## 5. Surface briefs

### 5.1 Landing `/` (Persuade)

- **Job:** a migrant arrives from search or a link. In one screen they learn that the characters remember them, in their DMs and their servers, and that they can bring their own. Then they continue with Discord.
- **Proof:** real product behaviour, demonstrated:
  - the memory a companion keeps, and that you can edit or forget it;
  - the DM/server boundary (Vault Rule);
  - a live strip of shelf listings, real data and only real counts;
  - character-card import.
  - Any demo content is labelled as an example. No invented ratings, handles or member counts.
- **First viewport:**
  - hook: "They remember you" plus the DMs-and-servers line (copy from the current working tree, `website/index.html`);
  - **Continue with Discord** as the primary action, with a line saying what happens next ("Sign in with Discord, then join the server");
  - **Browse the shelf** as the secondary action;
  - the "bring your character" import route visible.
- **Sequence:** one claim per section, never repeated.
  1. Remembers you: inspectable memory.
  2. Follows you: DMs ↔ servers, Vault Rule.
  3. Bring what you have: card and history import, supported formats, guide link.
  4. The shelf: live listings.
  5. Pricing: Free vs Premium; packs and BYOK as one line.
  6. Safety and privacy, stated plainly.
  7. FAQ, grouped into Getting started / Memory & privacy / Servers.
- The sequence is not a template stack; the chosen direction sets its composition.
- **Critique items answered:**
  - P1 hero → first viewport above.
  - P1 made-up proof → the proof rule.
  - P1 button path → primary path and microcopy.
  - P2 import section → section 3, plus a first-screen link.
  - P2 length → one claim per section, FAQ grouped, ledger cut.
  - Minors: off-palette button, sharing previews, "settle on the hour" explained, what happens to packs when Premium lapses (needs a product answer; see §8).
- **States:** signed-in visitors see the user chip, and the primary button becomes "Open your dashboard". Reduced motion gives a static demo.
- **SEO:** Organization, WebSite, SoftwareApplication (Offers from §8 prices) and FAQPage mirrored from the visible FAQ. Full OG and Twitter tags, and a new OG image matching the new hero.

### 5.2 Shelf index `/characters` (Persuade)

- **Job:** browse every published character and pick one to meet in Discord.
- **Content:** each listing shows avatar or initial, name, tagline, up to 3 tags, rating only when the count is above 0, and add count.
  - Typical size is tens to low hundreds of listings.
  - Add simple client-side tag filtering. It's progressive: the full list renders without JS.
- **States:**
  - empty: "Nothing on the shelf yet" plus the import route;
  - Supabase down: the same empty page, never a 500.
- **SEO:** `ItemList`.

### 5.3 Character page `/characters/[id]` (Persuade)

- **Content:** name, avatar, tagline, traits (≤6), tags (≤4), rating (only if count is above 0), adds, "a community creator", "Who they are", backstory, the first hello, More like this (4).
- **Primary action:** "Meet [name] in Discord", which goes to Continue with Discord and then the server, or straight to `LINKS.discord` when signed in.
- **Fix:** related cards show real ratings; fetch the rating stats once.
- **Performance:** related listings need the catalog. Cache it per isolate for the s-maxage window, rather than refetching all of it on every request.
- **States:** unknown or delisted id returns a real 404 page in the site shell, with canonical set to `/characters`.
- **SEO:** `Product` with a $0 Offer and `aggregateRating` only when the count is above 0, `BreadcrumbList`, and `og:image` set to the avatar.

### 5.4 Account `/account` (Operate)

- **Job:** get signed in fast, Discord first.
- **Order:**
  1. **Continue with Discord** (primary, full width).
  2. Then email, with tabs for Sign in / Create account / Email link.
  3. Forgot password and recovery as secondary modes.
- **Keep:**
  - every current behaviour in Appendix A §2;
  - ToS checkbox on sign-up;
  - resend button;
  - the 3s recovery timeout message;
  - URL error display;
  - redirect away if already signed in;
  - the `next` validation rule.
- **Fix:** sign-up and resend honour `next` (send `emailRedirectTo` with `authRedirectTarget()`), and `requireAuth` keeps the hash, so the Premium flow lands on `#billing`.

### 5.5 Dashboard `/dashboard` (Operate)

- **Job:** the back office. Link Discord, see and edit memory, import, manage tokens and billing.
- **First-run guide:** shown until Discord is linked and the user has at least one companion. Three steps: linked, join server, adopt or import. Each step shows a done state. This replaces the scattered "Link Discord above" locked notes.
- **Sections:** keep every plate's behaviour (Appendix A §3) and give it a clear hierarchy.
  1. Memory: "What X remembers" is the product's heart, so it comes first once linked.
  2. Import (card and chat history).
  3. Tokens.
  4. Companion settings.
  5. Billing.
  6. Profile and Discord link.
  7. Password.
  8. Delete account.
- **States for every section:** loading, locked (Discord not linked, with an inline link action), empty, error (mapped messages from `memories.js` `explain()` and the import error maps), success.
- **Billing:**
  - packs disabled for free users, with an explanation;
  - prices read from one config;
  - checkout requires a linked Discord account: a locked state with an inline "Continue with Discord" link, enforced again in `create-checkout` (§8);
  - state plainly that purchased packs stay spendable if Premium ends.
- **Remove:**
  - the dead `?checkout` handler;
  - the duplicate `my_companions` call, replaced by a single shared fetch.
- **Consent gate and delete modal:** keep as they are, behaviour-identical.

### 5.6 Legal and guides (Read)

- `/terms`, `/privacy`, `/security`, `/safety`: build-time rendered from the root `.md` files, with a table of contents, a last-updated stamp, previous/next document links, and OG tags.
- `/guides/import-character-cards`: a real how-to with steps, formats, limits and failure modes. It links to the dashboard import and to `/companion import`.

### 5.7 404 and emails

- **404:** in the site shell, with links to the shelf and home.
- **Auth emails (`supabase/email/`, live):** restyle to the new world after the build. Retire or sync the divergent `supabase/templates/` set (Appendix B).

## 6. Migration and cutover

1. Scaffold `web/` and port the worker endpoints and middleware first, with tests ported from `src/site-shelf.test.ts`.
2. Build the shelf and legal pages (low risk, SEO parity), then the landing page, account and dashboard.
3. Deploy as a preview worker (`characterly-website-preview`, on a workers.dev host).
   - Add its `/**` to the Supabase redirect allowlist.
   - Note that `create-checkout` CORS only allows `SITE_URL`, so checkout is tested on production after cutover, or `create-checkout` gets an allowlist.
4. Run the parity checklist (Appendix A), plus Lighthouse, an axe accessibility check, and checks with JS disabled on shelf and legal pages.
5. Cut over by deploying `web/` as `characterly-website`.
   - Verify `/discord/events` (Discord Developer Portal webhook) and the bot's `SITE_URL` avatar calls against the apex.
   - Watch Analytics Engine `page_view` and `web_event`.
6. Retire `website/`, `src/site-shelf.ts` HTML templates and `public/shelf.css`. Update `docs/website.md`, `docs/operations.md`, `AGENTS.md` and `website/README.md`.
7. Run the Impeccable finish review and documenter to write the new DESIGN.md and `.impeccable/design.json`.

The deploy order in AGENTS.md (bot → `stripe-webhook` → website) still applies to any billing change.

## 7. Verification

- Every Appendix A item maps to a route in §4 and a brief in §5, or is listed as retired.
- Critique P1/P2s are answered (§5.1).
- Shelf and legal pages work with JS disabled.
- The CSP has no `unsafe-inline` scripts.
- No invented proof. Prices match the Stripe catalog.
- Accessibility: keyboard paths through auth, dashboard and modals; visible focus; contrast ≥4.5:1; reduced motion.
- Re-run `/impeccable critique` on the new landing page. The target is ≥28/32.

## 8. Open decisions

**Decided (owner, 2026-10-21):**
- **Light only.** One pale-field theme with no dark variant. Set `color-scheme: light` explicitly.
- **Packs stay spendable after Premium lapses;** you just can't buy more. State this on pricing and in the billing section.
  - Verify against the v60 two-bucket spend path (`purchased_balance`) before the copy ships.
- **Checkout requires a linked Discord account.**
  - The dashboard billing section gets the locked state with an inline link action.
  - `create-checkout` adds a server-side check (409 "link Discord first"), since perks follow `discord_user_id`.
  - Deploy order per AGENTS.md: edge function first, then the website.
- **Hero character is Wren** (seed listing, `src/seed-personas.ts`). Her relationship line, "the friend who remembers what you told her and asks how it turned out", is the product thesis.
  - The owner produces full-height art with Nano Banana from the prompt in Appendix C, using `assets/marketplace/wren.jpg` as the identity reference.
  - Asset slot: `web/public/art/wren-archive.png`. The build uses a labelled placeholder until it lands.
  - The landing archive shows Wren and the example memories as an example, labelled so.

**Still open:**
1. **Accessibility target:** recommend WCAG 2.2 AA.
2. **Tag filtering on `/characters`:** client-only, or query-param SSR for SEO?
3. **OG image:** regenerate for the new hero (can reuse the Wren asset), and per-listing OG via avatar (as now) or a rendered archive card.

---

## Appendix A: feature parity inventory

From the 2026-10-21 read-only sweep. File references are to the current code.

**A1. Routes**
- `/`: meta and OG, JSON-LD @graph (Org, WebSite, SoftwareApplication with Free/Premium Offers, FAQPage ×10 mirroring the visible FAQ), session-aware nav, FAQ.
- `/account`, `/dashboard`: noindex.
- Legal ×4: `legal.js` renders the root `.md` files (h1 title, numbered h2 with TOC, `_Last updated_` stamp, lists, inline links/bold/code/italics, `.md` links remapped to routes, external links in a new tab).
- 404: via `notFoundHandling`.
- `/characters`, `/characters/<id>` (regex `^\/characters\/(\d+)\/?$`), `/guides/import-character-cards`, `/sitemap.xml` (static paths plus active listings with `lastmod`).
- `robots.txt`: disallows `/account`, `/dashboard`, `/discord/events`, `/avatar`, `/avatar/gc`, `/track`.

**A2. Auth** (`website/src/auth.js`, `account.js`)
- Modes: sign in, sign up, magic link, forgot, recovery, Discord OAuth.
- Sign in: "Wrong email or password" mapping.
- Sign up:
  - password ≥8 and ToS required;
  - beacons `signup_start`/`signup_done`;
  - `display_name` metadata;
  - immediate session → `recordConsent`;
  - otherwise a verification notice with resend.
- Magic link: `shouldCreateUser`.
- Forgot: generic notice.
- Recovery: `?mode=recovery`, 3s expiry message.
- `authRedirectTarget()` validation; `requireAuth()`.
- `signOut` clears local storage synchronously (supabase-js lock workaround).
- `deleteAccount`: raw fetch to the `delete_own_account` RPC with a bounded `getSession`.
- `withTimeout`.
- Consent: `my_consent`/`record_consent` (`terms`, `TERMS_VERSION=1`, in sync with `src/ops.ts`), fails closed.

**A3. Dashboard**
- 8s render guards.
- Time-of-day greeting.
- Profile: display name (≤48), member since.
- Discord:
  - OAuth vs code-linked rendering;
  - https-only avatar;
  - unlink rules (≥2 identities, or the `unlink_discord` RPC);
  - Link with Discord (`linkIdentity`);
  - `/link` code claim (`claim_link_code`, beacon `link_attempt`).
- Tokens:
  - `credit_balance`/`purchased_balance` split;
  - 00:00 UTC countdown;
  - `credit_ledger` last 8 with labels.
- Settings: `c2c_enabled`, `low_credit_alerts` via `upsert_my_settings` (reverts on error); BYOK status (`my_byok_status`).
- Memory:
  - companion picker (`my_companions`);
  - `my_memory_overview`;
  - story summary edit (≤4000);
  - memory pin/edit(≤1000)/forget;
  - journal pin/forget;
  - empty states;
  - `explain()` error map.
- Card import:
  - drop zone with keyboard and drag-and-drop, ≤8MB `.png`/`.json`;
  - `src/charcard.ts` parse and preview;
  - `card-avatars` upload at `<uid>/<sha256>.png`;
  - `import_companion_card`;
  - `reused` copy;
  - error map (slot full, cooldown, daily cap, import cap, …).
- History import:
  - `.jsonl`/`.json`/`.txt` ≤8MB;
  - `src/chathist.ts`;
  - companion picker with re-parse;
  - preview (turns, names, span, dropped speakers);
  - `import_chat_history`;
  - `my_chat_imports` status polling every 8s (queued/distilling %/done/failed);
  - `delete_chat_import` cancel/undo.
- Billing:
  - `create-checkout` with `premium`, `premium_yearly`, `pack_750`, `pack_2500`, `pack_7500`;
  - Premium/free gating;
  - beacon `checkout_click`;
  - error detail from `error.context`.
- Password change (≥8, must match).
- Delete account modal (type DELETE, Esc or backdrop closes, 10s timeout).

**A4. Worker** (`website/worker.ts`)
- Canonical 301 to the apex (localhost and 127.* exempt).
- `POST /discord/events`: Ed25519 check, 300s window, `record_app_install`, 500 on upstream failure.
- `PUT /avatar`: secret header compared in constant time; png/jpeg/webp/gif; ≤8MB; lazy `companion-avatars` bucket; returns `{url}`.
- `POST /avatar/gc`: deletes unreferenced objects older than 24h.
- `POST /track`: allowlist, `p` ≤80 chars, always 204.
- `page_view`.
- Security headers: CSP, nosniff, referrer and permissions policies.
- Shelf cache `max-age=60, s-maxage=300`.
- Secrets: `DISCORD_APP_PUBLIC_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AVATAR_UPLOAD_SECRET`.
- Bindings: `ANALYTICS` (`characterly_site`), `ASSETS`.

**A5. Shelf contract** (`src/site-shelf.ts`)
- Active-only, ordered by `add_count` desc.
- Degrades to empty or a 404, never a 500.
- `esc()` on all user fields, `nl2br` on persona, backstory and greeting.
- Generic attribution. JSON-LD brand "Characterly community".
- `relatedListings`: 2× tags + 1× traits, top 4.
- `ItemList`, `Product` (+`aggregateRating` only if the count is above 0), `BreadcrumbList`.

**A6. Data dependencies**
- Tables: `web_profiles`, `credit_ledger`; worker reads `companion_listings`, `listing_rating_stats`, `companions`, `companion_persona_versions`.
- RPCs: `unlink_discord`, `claim_link_code`, `my_bot_settings`, `upsert_my_settings`, `my_byok_status`, `import_companion_card`, `my_companions`, `my_chat_imports`, `import_chat_history`, `delete_chat_import`, `my_memory_overview`, `memory_pin`, `memory_update`, `memory_forget`, `journal_pin`, `journal_forget`, `story_summary_save`, `my_consent`, `record_consent`, `delete_own_account`, `record_app_install`.
- Buckets: `card-avatars`, `companion-avatars`.
- Edge function: `create-checkout`.
- Supabase dashboard config: Site URL, redirect allowlist, Discord provider, manual linking ON.

**A7. Assets and emails**
- `favicon.svg`, `mark.svg`, `seal.svg`, `apple-touch-icon.png`, `og.png`.
- Live auth emails: `supabase/email/` (confirm-signup, magic-link, reset-password, change-email; applied via `apply.mjs`).

## Appendix B: fix during the rebuild

1. Dead `?checkout` return handler (`dashboard.js:237-240`).
2. Sign-up and resend ignore `?next=`; `requireAuth` drops the hash.
3. Legal pages render on the client and are empty without JS.
4. The canonical 301 applies to API POSTs (they become GET on www/workers.dev).
5. Related shelf cards always say "unrated", and each character page fetches the whole catalog.
6. `DISCORD_INVITE` is duplicated (`site-shelf.ts:14` and `config.js`); the nav differs on every page.
7. Missing twitter title/description on `/`; no OG on legal pages and 404; no apple-touch-icon on the shelf.
8. Pack prices are hardcoded in four places. Use one source in `web/`, cross-checked against `create-checkout`/`stripe-webhook`.
9. Two diverging email template sets (`supabase/email/` is live; `supabase/templates/` is local only).
10. Stale docs: `docs/website.md` (build boundary, not-found), `docs/operations.md` (worker secrets, routes), `docs/handoff.md`, `website/README.md`.
11. `create-checkout` CORS allows a single origin, so there's no preview or local checkout.

## Appendix C: hero art prompt (Nano Banana)

Attach `assets/marketplace/wren.jpg` as the identity reference, then use this prompt. Generate at the tallest resolution available (2:3 portrait). Return the PNG. The build cuts it out, so a flat background is better than a scene.

> Using the attached image as the reference for her identity, create a full-height character portrait of the same woman, "Wren": wavy auburn shoulder-length hair, warm freckled face, gentle open smile, cream cable-knit cardigan over a dark floral dress, a thin gold necklace. Keep her face, hair and outfit consistent with the reference.
>
> Pose: standing, three-quarter view turned slightly toward the right of the frame, framed from mid-thigh up, both hands holding a ceramic mug of tea at chest height, head tilted a little as if she has just asked "how did it go?" and is waiting for the answer. Relaxed shoulders, friendly, attentive eye contact toward the viewer.
>
> Style: polished painterly character illustration with clean, confident edges and soft cel-like shading, like a character profile portrait in a modern story game's character archive. Not photorealistic, not chibi. Soft, even, cool daylight from the upper left with a gentle rim light, no candlelight or warm lamp glow.
>
> Background: a completely flat, solid pale periwinkle-white (#F2F5FF), with no scenery, props, floor, shadow on the ground, frame, border, vignette or texture, so the figure can be cleanly cut out.
>
> Composition: figure centred horizontally with generous headroom (about 8% above her hair), her body filling about 70% of the frame height, nothing cropped except below mid-thigh. Portrait orientation, 2:3 aspect ratio.
>
> No text, no logos, no watermark, no UI elements, no extra characters.

**If the first result drifts:**
- Face doesn't match: add "match the reference face exactly".
- Too photographic: add "illustrated, visible brush shaping".
- Background not flat: repeat "plain solid #F2F5FF background only".
