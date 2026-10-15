# Website & Web Accounts

The `website/` directory is a self-contained Vite multi-page app — the public face of Characterly and the "real-life user" half of the product (accounts, future billing). It shares the Supabase Postgres database with the bot but is otherwise independent: no build step touches `src/`, and the bot never serves it.

Production: **https://characterly-website.albertjemmettwaite.workers.dev** (Cloudflare Workers Static Assets).

---

## Pages

| Path | File | Purpose |
|------|------|---------|
| `/` | `index.html` + `src/main.js` | Landing page: animated companion chat demo, how-it-works, features, privacy/consent band, FAQ, CTAs (add the bot, join the Discord). Session-aware sidebar swaps "Sign in" ↔ user chip. |
| `/account` | `account.html` + `src/account.js` | Auth: sign in / sign up / magic link tabs, forgot-password flow, recovery mode for reset links, "Continue with Discord" (hidden unless `DISCORD_OAUTH_ENABLED`). |
| `/dashboard` | `dashboard.html` + `src/dashboard.js` | Auth-guarded account page: profile (display name), Discord link card (link/unlink + `/link` code claim), billing placeholder, password change, delete account (type-`DELETE` modal). |

`src/config.js` holds the public runtime constants — Supabase URL, publishable key, links, `DISCORD_OAUTH_ENABLED`. The publishable key is browser-safe by design; RLS enforces access. **Never put the service-role key in `website/`.**

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

To attach a real domain later: register/buy the domain, add it to the Worker in the Cloudflare dashboard, **then add `https://<domain>/**` to the Supabase redirect allowlist** (below) or OAuth/magic links on the new origin will fail.

---

## Supabase Auth setup (dashboard — required, manual)

These live in the Supabase dashboard, not the repo. Project: `tfukkoektmsrolykliop`.

### URL Configuration — `Auth → URL Configuration`

| Setting | Value |
|---------|-------|
| Site URL | `https://characterly-website.albertjemmettwaite.workers.dev` |
| Redirect URLs | `https://characterly-website.albertjemmettwaite.workers.dev/**` and `http://localhost:5173/**` |

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

---

## How Discord ↔ account linking works

`web_profiles.discord_user_id` is the join column and is **server-write-only** — `authenticated` can update only `display_name`/`updated_at` on their own row (column-level grants, v27), so a forged link can't steal another user's perks.

Two trusted paths write it:

1. **OAuth identity sync** — `on_identity_sync` trigger (`internal.sync_discord_identity`) on `auth.identities`. Discord OAuth sign-up, `linkIdentity` from the dashboard, and Supabase's same-verified-email auto-merge all write a `discord` identity row → the trigger copies `provider_id` (the Discord snowflake) into `discord_user_id`. Identity deletion (unlink, account delete) NULLs it back. If the snowflake is already bound to another account, the trigger raises `discord_already_linked`.
2. **`/link` code flow** — the bot's `/link` command mints a one-time `XXXX-XXXX` code (`link_codes`, 10-min expiry, one active code per Discord user, ephemeral reply). Claiming it on the dashboard calls `claim_link_code` (security-definer rpc, `auth.uid()`-guarded) which validates and stamps the link. This path exists for users who sign up with email and never touch Discord OAuth.

**Unlink:** the dashboard offers Unlink only when ≥2 identities exist (Supabase refuses to remove the last one — the UI explains the set-a-password escape hatch for OAuth-only accounts). `web_profiles.stripe_customer_id` is reserved for the future billing phase; perks will read `discord_user_id → plan` in the bot.
