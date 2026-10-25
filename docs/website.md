# Website (`web/`) + account linking

`web/` is an Astro app on Cloudflare Workers (`@astrojs/cloudflare`), worker
name `characterly-website`, live at `https://characterly.app` (non-apex hosts
301 to the apex). It replaced the old Vite build (archived at
`archive/website/`) and owns five surfaces: the marketing pages, the SSR
marketplace **shelf** under `/characters`, opt-in public **creator pages**
under `/creators/<slug>`, **web chat** under `/chat` (v73 — full contract in
`docs/web-chat-frontend.md`), the **account**/**dashboard** plates, and the
worker-only API lanes.

## How a page is built

| Route | File | Mode |
|-------|------|------|
| `/` | `src/pages/index.astro` | SSR — live shelf strip |
| `/characters`, `/characters/[id]` | `src/pages/characters/*` | SSR — catalog + per-listing pages (tabs incl. *First hello* and, when the listing has alternate openings, *More ways to meet*; a `loreCount` stat shows "World lore · N entries" — count only, keys/content stay hidden). The byline links to the creator page when the creator has opted into one, otherwise it stays "a community creator" |
| `/creators/[slug]` | `src/pages/creators/*` | SSR — opt-in public creator pages: brand name, bio, live characters + a rating/adoption rollup. Absent/private/banned → real 404; upstream failure → 503, never a false absence |
| `/terms` `/privacy` `/security` `/safety` | `src/pages/[doc].astro` | prerendered at build time from the repo-root `*.md` files via `src/lib/legal.ts` |
| `/guides/...` | `src/pages/guides/*` | prerendered |
| `/account`, `/dashboard`, `/404` | matching `.astro` + `src/scripts/*.ts` | prerendered shells — all auth/data work is client-side supabase-js (creator-page saves ride `POST /creator-profile`, see below) |
| `/chat`, `/chat/[id]` | `src/pages/chat/*` + `src/scripts/chat*.ts` | prerendered shells — web chat (v73): roster + thread against `web_*` RPCs, private realtime `web-messages:<uid>` + polling fallback, consent-gated like the dashboard. Full contract: `docs/web-chat-frontend.md` |
| `/sitemap.xml` | `src/pages/sitemap.xml.ts` | generated from `sitemapXml` in the bot's `src/site-shelf.ts` — static paths, live listings, and public creator slugs (banned creators excluded) |

Shared code is imported cross-tree, never duplicated: `web/src/lib/shelf.ts`
pulls the catalog/cache/label helpers from the bot's `src/site-shelf.ts`
(the bot's test suite covers them), and `src/charcard.ts`,
`src/chathist.ts`, `src/discord-events.ts`, `src/seed-personas.ts` feed the
site too.

The worker (`web/src/worker.ts`) runs ahead of every request
(`run_worker_first`): canonical-host redirect, security headers + CSP on
HTML, `POST /track` → Analytics Engine `web_event` (allowlist:
`signup_start`, `signup_done`, `checkout_click`, `link_attempt`,
`discord_signin_click`) plus `page_view` beacons, `POST /discord/events`
→ `record_app_install`, `PUT /avatar` / `POST /avatar/gc` (shared-secret
`AVATAR_UPLOAD_SECRET`), `POST /creator-profile` (the screened save lane —
see *Creator pages* below), and `OPTIONS` for the API lanes. Everything else
falls through to Astro.

## Creator pages (`/creators/<slug>`, v70)

Opt-in public profiles for marketplace creators — **off by default**: a
creator's Discord identity stays Discord-side unless they claim a page in
dashboard → *Creator page*. The profile is a separate public brand
(`creator_name`), not the dashboard `display_name` and never the Discord
username.

- **Write path:** the dashboard form POSTs `/creator-profile` (implemented in
  `src/creator-profile.ts` — bot-src so the suite covers it). The creator
  columns carry **no authenticated UPDATE grant**, so this endpoint is the
  sole write path — a direct client PATCH is denied at the grant level.
  Pipeline: user-JWT verify → linked `discord_user_id` → not
  marketplace-banned → field validation → deterministic blocklist on every
  save → the shared `buildSafetyVerdictPrompt` model screen when (and only
  when) the save makes the page public → service-role PATCH. Provider
  failure fails closed (503, nothing written).
- **Read path:** `fetchCreatorBySlug` filters `creator_public=eq.true` +
  non-null slug at the PostgREST boundary and joins `marketplace_bans`
  server-side — banned creators' pages are a real 404, exactly like absent
  or private ones. `discord_user_id` is the internal join key to listings;
  it resolves the page but is never rendered into markup or JSON-LD.
- **Surfaces:** `/characters/[id]` swaps its byline for a `by <name>` link
  only when the creator is public (banned/private → anonymous);
  `/sitemap.xml` includes public creator slugs, banning excluded. A public
  creator with zero live listings still renders (the page is about the
  person), with an empty-state card.
- **The slug:** `/creators/<slug>` — `^[a-z0-9][a-z0-9-]{2,31}$`, plus a
  reserved list (`admin`, `staff`, `characterly`, `support`, …) enforced in
  the v70 CHECK constraint, not just client-side.

The design system ("The Character Archive") is captured in `DESIGN.md` at
the repo root.

## Account linking (`/link` ↔ dashboard)

Two layers:

- **Web account** (Supabase Auth, email or Discord OAuth) — required for
  hosted-credit chat and marketplace publishing.
- **Discord linkage** (`web_profiles.discord_user_id`) — connects that
  account to a Discord user.

Flow A (site-first): sign in on the site → dashboard → **Link Discord** →
supabase-js `linkIdentity('discord')` → OAuth **scope `identify` only** (no
`guilds.join`) → Discord returns a second identity on the same account →
dashboard reads `identities[].provider === 'discord'` and PATCHes
`web_profiles.discord_user_id`. On the next sign-in an `identities`
changed-callback does the same PATCH automatically. **Supabase Dashboard
→ Authentication → Sign In/Providers → "Allow manual linking" must be ON**
— without it `linkIdentity` errors in the browser.

Flow B (DM-first): user runs `/link` in Discord → bot inserts a `link_codes`
row (10-min expiry) → reply contains a one-click URL
`https://characterly.app/dashboard?code=XXXX-XXXX` → dashboard prompts
sign-in → POSTs to `POST /auth/v1/.../rpc/claim_link_code` (SECURITY
DEFINER — validates code + caller, stamps `discord_user_id`, returns the
Discord identity JSON the code pre-fetched from the Discord API) → balance
shows in `/tokens`, hosted-credit chat works, publish/adopt gates pass.

## Supabase Auth setup

- **Site URL:** `https://characterly.app`
- **Redirect URLs** (must include):
  `https://characterly.app/**` (covers `/account`, `/dashboard`,
  `/onboarding`, and every `?next=` return target), and
  `http://localhost:4321/**` for dev.
- **Email:** enable Email provider. Confirm-email ON if you want verified
  emails before the dashboard works.
- **Discord:** enable the Discord provider with the app's
  Client ID/Secret; Discord Developer Portal → OAuth2 → Redirects must
  include `https://<project-ref>.supabase.co/auth/v1/callback`.
- **Manual linking:** ON (see Flow A).

Google and Apple were considered and dropped — the account only exists to
bind a Discord identity, so the native Discord button plus email cover the
whole funnel.

## OAuth return URLs

Supabase's `redirectTo` must be **allowlisted** in the project config. The
client passes `authRedirectTarget()` (current origin + `?next=` when
present); after OAuth completes Supabase redirects back and
`onAuthStateChange` picks up the session on whatever page it lands on —
the dashboard then navigates to `?next=` if set. This means a sign-in on a
live origin not in the allowlist breaks OAuth entirely while email still
works — if Discord sign-in fails with a redirect error, add the origin
to Supabase → Authentication → URL Configuration first.

## Discord-sign-in UTM param

The account page's Discord OAuth button adds `utm_source=discord_signin`
to `redirectTo`, and the Supabase Discord provider's callback URL carries
the same param (paste it in the Discord dev portal's redirect list). Stripe
Checkout return URLs keep UTM params (Stripe preserves the querystring on
the built success/cancel URLs), so `?utm_source=discord_signin` on a
checkout completion tells you the signup came through the Discord lane vs
email — `discord_signin_click` is the matching `web_event` beacon.

## Session teardown notes

- Sign-out doesn't ride the SDK's session path: `signOut()` in
  `src/scripts/auth.ts` manually removes `sb-*-auth-token` keys from
  `localStorage` *then* calls `supabase.auth.signOut({ scope: "local" })`.
  supabase-js `signOut()` can hang on a dead session (the
  `navigator.locks` wedge), which previously left the session alive while
  the UI looked signed out.
- Account deletion reads the access token straight out of `localStorage`
  for the same reason, POSTs to `POST /auth/v1/.../rpc/delete_own_account`,
  then signs out — `web_profiles` and everything beneath it cascade on
  `auth.users` deletion.
- `discord_user_id` is protected by a trigger: PATCH attempts to change it
  once set are refused (`discord_id_locked`). Re-link flow: delete the
  account, sign up again, link the correct Discord.

## Operational notes

- Deploy: `cd web && npm run deploy` (`astro build` + `wrangler deploy`).
  `CLOUDFLARE_ENV=preview npm run deploy` ships `characterly-website-preview`.
- Worker secrets: `DISCORD_APP_PUBLIC_KEY`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `AVATAR_UPLOAD_SECRET`, and `GROQ_API_KEY`
  (the `/creator-profile` model screen — unset means deterministic-only,
  same semantics as the bot's missing key; `GROQ_BASE_URL`/`SAFETY_MODEL`
  optional overrides) — set via `wrangler secret put` or the dashboard; the
  publishable anon key lives in `src/lib/config.ts` (safe — RLS enforces).
- Local dev: `cd web && npm run dev` → `http://localhost:4321` (Astro dev —
  CSP/worker rules don't run; `npm run preview` builds and serves under
  `wrangler dev` with real headers). `npm test` covers the worker rules and
  allowlists. Without `SUPABASE_SERVICE_ROLE_KEY` in `.dev.vars` the shelf
  falls back to the seed roster via `devFixture` — dev only.
- Browser/env overrides: `PUBLIC_SUPABASE_URL` and
  `PUBLIC_SUPABASE_PUBLISHABLE_KEY` env vars override `config.ts` at build
  time — that's the staging-host switch.
- Site copy (links, plans, `TERMS_VERSION`, Support button URL): single
  source in `web/src/lib/config.ts`.
- The legacy Vite site lives at `archive/website/` for reference; its
  `config.js`/`legal.js`/`shell.js` model is superseded — don't patch it.
