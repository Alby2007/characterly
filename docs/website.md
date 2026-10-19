# Website & Web Accounts

The `website/` directory is a self-contained Vite multi-page app — the public face of Characterly and the "real-life user" half of the product (accounts, billing). It shares the Supabase Postgres database with the bot but is otherwise independent: no build step touches `src/`, and the bot never serves it.

Production: **https://characterly.app** (Cloudflare Workers Static Assets — `characterly-website` worker; `www.characterly.app` serves the same worker. The `workers.dev` hostname stays live for backward compatibility).

---

## Pages

| Path | File | Purpose |
|------|------|---------|
| `/` | `index.html` + `src/main.js` | Landing page: hero with a looping companion chat scene + journal page, at-a-glance ledger, how it works (awaken / summon / remember, each with a product figure), "what it's like" notes, **pricing** (Free vs featured Premium — hosted is the default frame, BYOK reduced to a footnote since that's the funnel), privacy vault, FAQ, closing CTA. The Premium CTA goes to `/account?next=/dashboard#billing` — auth bounces then lands on the billing plate, which carries the `client_reference_id`'d Stripe links (bare links can't attribute a pre-account purchase). Session-aware nav swaps "Sign in" ↔ user chip. |
| `/account` | `account.html` + `src/account.js` | Auth: sign in / sign up / email link tabs, forgot-password flow, recovery mode for reset links, "Continue with Discord" (hidden unless `DISCORD_OAUTH_ENABLED`). Split layout on desktop, form only on mobile. |
| `/dashboard` | `dashboard.html` + `src/dashboard.js` | Auth-guarded account page: profile (display name), Discord link card (link/unlink + `/link` code claim — renders the Discord username/avatar snapshot stored on `web_profiles`), **Tokens** plate (balance, plan, recent `credit_ledger` rows — visible once Discord is linked), **Companion settings** plate (c2c toggle, low-token DM alerts, read-only BYOK status — via `my_bot_settings`/`upsert_my_settings`/`my_byok_status` rpcs), **What X remembers** plate (`src/memories.js` — per-companion picker listing DM-scope memories, journal entries, and story recaps with pin/edit/forget controls — via `my_memory_overview`, `memory_pin`, `memory_update`, `memory_forget`, `journal_pin`, `journal_forget`, `story_summary_save`; the same rows Discord's `/memory`, `/forget`, and `/companion story` reach), **Import a character** plate (`src/import-card.js` — parses a `.json`/`.png` card client-side with the shared `charcard` parser, previews, uploads an extracted avatar to the `card-avatars` bucket, creates listing+clone via `import_companion_card`), **Billing** plate (Premium subscribe + token packs — buttons call the `create-checkout` edge function which mints a Checkout Session server-side after checking `plan`: packs require premium, subscribe requires non-premium; `client_reference_id` is forced to the caller's account and `metadata.checkout_kind` tells the webhook what was bought. The public payment links are deactivated — they couldn't gate anything), password change, delete account (type-`DELETE` modal). First-visit authed users without a `consent_events` row at `TERMS_VERSION` are held behind an acceptance modal (`ensureConsent`) — the web-side clickwrap. |
| `/terms`, `/privacy`, `/security` | `terms.html` / `privacy.html` / `security.html` + `src/legal.js` | The legal documents, rendered at build time from the repo's `TERMS.md`/`PRIVACY.md`/`SECURITY.md` into styled sheets — editing the `.md` redeploys the copy. These are the URLs `TERMS_URL`/`PRIVACY_URL` (`config.siteUrl` + path) in `src/ops.ts` point at, and the clickwrap targets on both the signup checkbox and the Discord verify gate. |
| 404 | `404.html` | Served by the Worker's `notFoundHandling: "404-page"`. |

Every page script imports `src/base.js` first — fonts, `styles.css`, `data-link` URL injection from `config.js`, nav scroll/mobile-menu behaviour, and `.rv` scroll reveals.

`src/config.js` holds the public runtime constants — Supabase URL, publishable key, links, `DISCORD_OAUTH_ENABLED`. The publishable key is browser-safe by design; RLS enforces access. **Never put the service-role key in `website/`.**

## Design system — "The Familiar"

A candlelit study at 1am: a companion as a familiar bound to you, written about in a hand-bound journal. Warm and intimate rather than playful; all tokens live at the top of `src/styles.css`.

- **Colour:** warm ink backgrounds (`--bg` `#0d0a0e`), parchment text (`--paper*`), candlelight gold accents (`--gold*`), wax red for seals, and `--ghost` teal reserved **only** for companions (avatars, names, the COMPANION tag) so they read as a distinct presence. The one light surface is the journal page (`.sheet`).
- **Type:** Fraunces (display, `opsz` axis; italics in gold for emphasis instead of gradient text), Instrument Sans (body/UI), IBM Plex Mono (catalogue labels, commands, timestamps). All self-hosted via `@fontsource`.
- **Motifs:** `public/mark.svg` (crescent + star seal mark, also the favicon), `public/seal.svg` (wax seal), engraved corner ticks on `.figure-frame`/`.plate`, double-ruled frames on `.vault`/`.folio`, `fig. i` captions. Use them sparingly.
- **Motion:** slow candle flicker on background glows, ink-settle reveals (`.rv`, stagger with `style="--d:N"`). Everything is disabled under `prefers-reduced-motion`; reveals only hide content when the inline `js` class is present.
- **Copy voice:** plain, specific, second person. Say what the product does; avoid hype words.

## Local development

```bash
cd website
npm install
npm run dev    # http://localhost:5173
```

## Deployment

```bash
cd website
npm run deploy   # vite build (Cloudflare plugin emits the Build Output Spec) + cf deploy
```

`cloudflare.config.ts` declares the `characterly-website` Worker (static assets only, SPA-style not-found handling, observability on). First deploy requires `cf login`. Deploys are manual — the site is not part of CI.

Custom domains are attached through the Cloudflare API (`PUT /accounts/{account_id}/workers/domains` with `{ zone_id, hostname, service: "characterly-website", environment: "production" }`) since the `cf` beta CLI doesn't expose worker domains yet. Adding a new hostname still requires its `https://<host>/**` pattern in the Supabase redirect allowlist (below) or OAuth/magic links on that origin will fail.

---

## Supabase Auth setup (dashboard — required, manual)

These live in the Supabase dashboard, not the repo. Project: `tfukkoektmsrolykliop`.

### URL Configuration — `Auth → URL Configuration`

| Setting | Value |
|---------|-------|
| Site URL | `https://characterly.app` |
| Redirect URLs | `https://characterly.app/**`, `https://www.characterly.app/**`, `https://characterly-website.albertjemmettwaite.workers.dev/**` (legacy, keep while the hostname stays live), and `http://localhost:5173/**` |

The `/**` glob covers verification emails, magic links, password recovery, and OAuth callbacks on each origin. Add a new origin's `/**` pattern here whenever the site's hostname changes (custom domain, preview deploys).

### Discord provider — `Auth → Providers → Discord`

- **Enabled**, with the bot application's **Client ID** and **Client Secret** from the [Discord Developer Portal](https://discord.com/developers/applications) → the bot's app → OAuth2. (The client secret is independent of the bot token — resetting one doesn't touch the other.)
- Copy Supabase's **Callback URL** (`https://tfukkoektmsrolykliop.supabase.co/auth/v1/callback`) into the Discord app's **OAuth2 → Redirects** list, then save in both portals.
- Flip `DISCORD_OAUTH_ENABLED = true` in `website/src/config.js` and redeploy.

### Other toggles

| Setting | State | Why |
|---------|-------|-----|
| **Allow manual linking** (`Auth → Sign In / Providers`) | **ON — required** | Without it `linkIdentity()` errors and the dashboard's Link Discord button does nothing. |
| **Leaked password protection** (`Auth → Password security`) | Recommended ON | HaveIBeenPwned screening; Supabase advisor flags it when off. |
| Email confirmations | ON (default) | Sign-ups get a verification link; redirect allowlist must cover the landing page. |

### Auth email templates

Branded templates live in `supabase/email/` (`confirm-signup`, `magic-link`,
`reset-password`, `change-email`) — hosted projects don't read email
templates from `config.toml`, so they're applied via the Management API:

```bash
SUPABASE_ACCESS_TOKEN=sbp_... node supabase/email/apply.mjs --check  # read live state
SUPABASE_ACCESS_TOKEN=sbp_... node supabase/email/apply.mjs          # apply all four
```

(or paste each file into Dashboard → Authentication → Email Templates).
The script refuses to apply a file missing `{{ .ConfirmationURL }}` — a
template without its link is a dead letter. Invite/reauthentication
templates stay at Supabase defaults (nothing on the site fires them).

---

## How Discord ↔ account linking works

`web_profiles.discord_user_id` is the join column and is **server-write-only** — `authenticated` can update only `display_name`/`updated_at` on their own row (column-level grants, v27), so a forged link can't steal another user's perks.

Two trusted paths write it:

1. **OAuth identity sync** — `on_identity_sync` trigger (`internal.sync_discord_identity`) on `auth.identities`. Discord OAuth sign-up, `linkIdentity` from the dashboard, and Supabase's same-verified-email auto-merge all write a `discord` identity row → the trigger copies `provider_id` (the Discord snowflake) into `discord_user_id`. Identity deletion (unlink, account delete) NULLs it back. If the snowflake is already bound to another account, the trigger raises `discord_already_linked`.
2. **`/link` code flow** — the bot's `/link` command mints a one-time `XXXX-XXXX` code (`link_codes`, 10-min expiry, one active code per Discord user, ephemeral reply) carrying a snapshot of the caller's Discord `username`/`avatar` (v38). Claiming it on the dashboard calls `claim_link_code` (security-definer rpc, `auth.uid()`-guarded) which validates and stamps the link — copying the snapshot onto `web_profiles.discord_username`/`discord_avatar_url` so code-linked accounts render a Discord identity in the dashboard exactly like OAuth-linked ones (the identity trigger stamps the same fields for OAuth rows; `unlink_discord` clears them). This path exists for users who sign up with email and never touch Discord OAuth. A boot-time store backfill (`syncDiscordIdentity`) heals rows linked before snapshots existed.

**Unlink:** identity-backed links use `unlinkIdentity` — the dashboard offers Unlink only when ≥2 identities exist (Supabase refuses to remove the last one — the UI explains the set-a-password escape hatch for OAuth-only accounts). Code-claimed links have no identity row, so the dashboard calls `unlink_discord` (v28 rpc, own-row only) instead — always permitted since it isn't an auth identity. `web_profiles.stripe_customer_id` / `stripe_subscription_id` (v31) are written by the Stripe webhook edge function (`supabase/functions/stripe-webhook`): `checkout.session.completed` grants packs (idempotent on session id via `credit_ledger.stripe_ref`) or flips `plan='premium'`; `customer.subscription.updated/deleted` move plan back down. Checkout sessions carry `client_reference_id=<web_profiles.id>` (and `metadata.checkout_kind`) so fulfillment attributes correctly — the webhook still accepts the legacy `payment_link` routing so deliveries created before the links were deactivated still land. Perks read `discord_user_id → plan` in the bot. The hosted lane charges **tokens** (`credit_balance` on `web_profiles`, audited by `credit_ledger`): a human's turn costs 2 (their message + the companion reply, 1 refunded if no reply lands), companion-to-companion hops cost the replying companion's owner 1 — which is exactly why the c2c dashboard toggle is a spend control. Grants are lazy (applied inside the spend tx) and BYOK lanes never spend tokens.

**`?next=` redirects:** `requireAuth()` (auth.js) bounces signed-out visitors to `/account?next=<attempted path>`; `authRedirectTarget()` validates it (same-origin `/`-prefixed paths only — blocks open redirects) and every post-auth navigation honors it: password sign-in, magic link (`emailRedirectTo`), Discord OAuth, and recovery. Default is `/dashboard`.

**Session teardown can't wait on the network.** supabase-js guards token access behind a `navigator.locks` lock, and a wedged auth call (e.g. a hung `/logout` — a known upstream edge against a dead session) holds it forever, silently queueing every later auth-touching call. So: `signOut()` clears `sb-*-auth-token` keys synchronously and fires `/logout` revocation in the background (navigation is unconditional); `deleteAccount()` reads the stored access token and POSTs `delete_own_account` via raw `fetch`, bypassing the SDK's lock-guarded session path (a bounded `getSession()` refresh is tried first). Both are raced with `withTimeout`, and the delete modal surfaces failures inline (`#delete-error`, case-insensitive `DELETE` confirm) rather than `alert()`. On `/dashboard`, sign-out/delete listeners attach before every network-bound render — profile, Discord card, tokens, settings renders are each capped at 8s and non-fatal — so a hung RPC can never leave the buttons inert.
