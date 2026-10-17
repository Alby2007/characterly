# Operations Runbook

How production Characterly runs, deploys, and gets un-stuck.

---

## Topology

| Piece | Where | Notes |
|-------|-------|-------|
| Bot process | Oracle Cloud VM (Oracle Linux 9, aarch64) | systemd unit `characterly`; code lives at `~/characterly` |
| Database | Supabase Postgres (`tfukkoektmsrolykliop`) | Session pooler connection string in the service's env |
| Website | Cloudflare Workers (`characterly-website`) | Static assets; see [website.md](website.md) |
| CI/CD | GitHub Actions → `.github/workflows/test.yml` | Test → gated deploy |

The bot is a single Node process — Discord gateway, live message loop, job-queue worker, and nightly maintenance all in one. There is no separate worker fleet; "scale" means the queue's per-guild serialization, not more processes.

## Deploy pipeline

```
push to main
  └─ test job: npm ci → npm run check → npm test (postgres:16 service)
       └─ green → deploy job (environment: production, concurrency group, no cancel)
            └─ SSH to the VM: cd ~/characterly && git pull --ff-only && npm ci
               && sudo systemctl restart characterly
```

- Red builds never deploy — `deploy` has `needs: test`.
- `environment: production` allows attaching required reviewers in repo settings if deploys should ever need approval.
- SSH uses three repo secrets: `ORACLE_SSH_KEY` (private key), `ORACLE_SSH_HOST` (`user@ip`), `ORACLE_HOST_KEY` (`ssh-keyscan` output — pinned host key, fails closed on MITM). Pinned action SHAs only.
- **A merge that adds a dependency requires `npm ci` before restart — the deploy does this for you.** The comment in `test.yml` predates `tsx` moving to `dependencies`; `npm ci --omit=dev` would now work, but full install is what runs.
- Migrations auto-apply at boot (`MemoryStore.create` → `runMigrations`) inside a transaction per version — a failed migration leaves the previous version recorded and the service crash-loops rather than running on a half-applied schema.

## Day-2 commands on the VM

```bash
sudo systemctl status characterly     # service state
journalctl -u characterly -f          # live logs
journalctl -u characterly --since "1 hour ago" --no-pager | tail -200
sudo systemctl restart characterly    # restart (e.g. after manual env change)
cd ~/characterly && git log --oneline -3   # what's deployed
```

Env lives in `~/characterly/.env` on the VM — **not** in the repo. Changes need a `systemctl restart`.

## House ops (`/ops`) — the bot operates our server + its own host

When `HOUSE_GUILD_ID` is set, `src/ops.ts` runs a private operator layer: member ops (welcome, verify gate, link sweep, raid detection), deterministic automod, channel layout (`ensureHouseLayout` on boot + `/ops layout`), and host self-ops (watchdog + `/ops`). The `/ops` console itself works even when `HOUSE_GUILD_ID` is unset — it controls the box, so it's initialized unconditionally; only the guild-facing pieces (layout, watchdog, member ops, boot announce) gate on the house id.

**`/ops` (allowlisted via `OPS_USER_IDS`, works in the house guild or DM):**

| action | effect |
|---|---|
| `status` | Health embed — uptime, heap/RSS, event-loop lag, disk, DB ping, **fleet-wide** queue depth, deployed sha |
| `logs [lines]` | `journalctl -u characterly -n N --no-pager`, secret-redacted, chunked under 2000 chars |
| `restart` | `process.exit(1)` — `Restart=always` in the unit brings it back on the same code |
| `deploy` | `git pull --ff-only && npm ci` in `OPS_REPO_DIR`, then exits (systemd restarts onto new code). On failure it reports where the tree *actually* sits — a landed pull + failed `npm ci` leaves HEAD advanced with mismatched deps, so the message shows both head and running sha |
| `announce <text>` | Posts to `HOUSE_ANNOUNCE_CHANNEL_ID` as the bot |
| `layout` | Creates any missing house channels/categories (idempotent) — created children inherit the parent category's permission overwrites, so a rebuilt mods/ops channel never comes up public. Reconciles the `characters` forum to Gallery View (`default_forum_layout`) so listing cards render covers on the main page. Also enforces read-only surfaces: categories/channels flagged `readOnly` in `WANTED_LAYOUT` get a Member-role deny on SendMessages/SendMessagesInThreads/CreatePublicThreads/CreatePrivateThreads (ViewChannel preserved) — category-level when children are synced so they stay synced, per-channel for mixed parents (SYSTEM) or unsynced children |
| `seedmarket` | Publishes the official seed roster (`src/seed-personas.ts`) under the bot's own account — idempotent: name-matched rows skip (with a cover retrofit that attaches `assets/marketplace/<coverFile>` art to pre-art OP messages), leftover delisted seeds relist + re-post their thread, flagged/moderated rows are left alone |

**Host watchdog** — every `HOST_HEALTH_INTERVAL_MS` (5m): heap %, disk %, event-loop lag, DB ping. A breach pings `OPS_CHANNEL_ID` **once**, then a recovery notice when it clears.

**Automod rules** (house guild only, deterministic, exempts `Manage Messages` holders + bots; runs before archiving so deleted spam never enters the memory pipeline): invite links → delete + alert · scam classes (nitro/crypto/steam/earn-money) → delete + 10m timeout + alert · mass mention (>8 user+role, or `@everyone` without permission) → delete + alert · burst spam (>6/8s) → delete + 5m timeout + alert · new account (<7d) + link → delete + alert. A 60s per-author action cooldown keeps repeat offenses deleting silently instead of re-alerting.

**Member ops** — welcome the moment someone joins (pending members can read channels even though they can't interact, so "read rules → verify" lands at join, not after rules acceptance), leave logs, and a 60s join-window raid detector. While the window is hot the public welcome is suppressed so raiders don't flood the channel — a pending join suppressed this way gets greeted when they accept the rules (`pending→false` flip is the fallback welcome; a per-boot `welcomed` set dedupes so nobody is greeted twice, and leaving clears it so rejoins re-greet); `AUTOMOD_RAID_KICK=1` switches to auto-kick.

**Verify gate** — `Member` means *verified Characterly member*, not just passed screening. `@everyone` sees only the lobby (`welcome`, `rules`, the gate channel); everything else needs Member/Mod/Admin. Rules acceptance itself is guild-side: the server runs COMMUNITY + `MEMBER_VERIFICATION_GATE_ENABLED` with the TERMS form (`rules_channel_id` → `#rules`), so new joins arrive `pending` until they accept — the bot only watches the `pending→false` flip. **Deliberate exception:** the `[CHARACTER MARKETPLACE]` category and `#characters` forum are `@everyone`-visible as the shop window — browse-only (`SendMessages`/`SendMessagesInThreads` denied; post creation stays bot-only), while Member/Mod/Admin may comment in listing threads. Add is refused for unlinked users (an ephemeral pointer at the gate channel) — an adoption without a linked account or BYOK key would own a companion the DM gate won't serve. A persistent card in `HOUSE_VERIFY_CHANNEL_ID` carries the **Verify** button: pending members are told to accept the rules first, unlinked users get pointed at the site + `/link`, and linked accounts hit the **clickwrap step** — an ephemeral reply carrying the [Terms](../TERMS.md) + [Privacy](../PRIVACY.md) links and an **"I accept"** button (`house:consent:<v>`). Clicking records a `consent_events` row (user, account, the version stamped on the button, `source='discord_verify'`, timestamp) and only then grants Member. A stored acceptance satisfies the gate only while its `version ≥ TERMS_VERSION` (a code constant — bump it in the same commit that edits the documents); stale or missing consent re-prompts, and the consent check sits *before* the already-Member early-out so an unconsented Member who clicks Verify can self-heal. Consent-click failures fail closed (no record ⇒ no role); the consent *lookup* erroring replies "try again" rather than granting. The card is idempotent — `ensureVerifyGate` scans recent bot messages on boot (unwrapping the Collection's `[id, msg]` pairs), posts only when missing, and deletes duplicate bot-authored cards it finds.

**Link sweep** — unlinking a Characterly account happens on the website (`web_profiles.discord_user_id`), which the bot can't observe. A periodic sweep (same cadence as the watchdog) re-checks every Member-role holder against `accountForDiscordUser`; a null (unlinked) result removes the role and logs to the ops channel. A lookup *error* keeps the role — a DB hiccup must never masquerade as unlinking, or an outage would mass-revoke every Member. The sweep also enforces the clickwrap gate: a *linked* holder whose `consent_events` max version is missing or below `TERMS_VERSION` loses Member the same way (they re-verify through the gate channel to come back). Consent-lookup errors are fail-safe keep, mirroring the link check. Worst-case revocation lag is the account cache TTL (60s) plus one sweep interval (~6 min at defaults). Self-host (`creditsSupported` false) skips the sweep — every Discord user maps to a synthetic account anyway.

**Website consent (the `web_signup` source)** — the same clickwrap exists on the web side. The legal documents are hosted at `/terms`, `/privacy`, `/security` — pages that render the repo's `TERMS.md`/`PRIVACY.md`/`SECURITY.md` into styled sheets at build time (`website/src/legal.js`), so editing the .md files redeploys the site copy and those are what `TERMS_URL`/`PRIVACY_URL` in `src/ops.ts` point at (`config.siteUrl` + path — keep the two constants in step). Signup carries a required agree-checkbox; when a session comes back immediately the site records `record_consent(TERMS_VERSION)` — when email-confirm defers the session, and for every OAuth/magic-link signup that never sees the checkbox, the dashboard's `ensureConsent` gate holds rendering behind an acceptance modal on first authed visit. Both paths go through the `record_consent` RPC (security definer, `auth.uid()`-keyed — the publishable key can't touch `consent_events` directly). `tosAcceptance` matches on `discord_user_id` **or** `account_id`, so a linked Discord member whose consent came from the site verifies cleanly — one acceptance covers the whole product. `website/src/config.js` exports a `TERMS_VERSION` that must be bumped in the same commit as `src/ops.ts`'s.

**Prerequisites when enabling:** (1) toggle **Server Members Intent** in the dev portal *before* deploy — login fails without it; (2) grant the bot role **Manage Messages, Moderate Members, Manage Roles, Kick Members, Manage Channels** on the house server; (3) set `OPS_USER_IDS` — `/ops` controls the box, so it's person-allowlisted, not role-based. The systemd unit already carries `Restart=always` (verified), and `opc` is in `systemd-journal` so `journalctl` needs no sudo.

## Database access

Supabase dashboard → SQL Editor, or `psql "$DATABASE_URL"`. The bot connects as `postgres` (bypasses RLS). Useful checks:

```sql
SELECT * FROM schema_migrations ORDER BY version;          -- migration state (latest: 42)
SELECT type, count(*), max(attempts) FROM jobs
  GROUP BY type;                                         -- queue depth
SELECT * FROM jobs WHERE attempts >= 5;                  -- dead letters
SELECT guild_id, day, llm_calls FROM guild_usage
  ORDER BY day DESC LIMIT 20;                            -- LLM spend per guild/day
SELECT llm_calls FROM guild_usage
  WHERE guild_id = 'hosted:global' AND day = CURRENT_DATE; -- hosted breaker: today's fleet-wide hosted calls vs HOSTED_DAILY_LLM_CAP
SELECT count(*) FROM web_profiles WHERE discord_user_id IS NOT NULL;  -- linked accounts
SELECT discord_user_id, plan, credit_balance FROM web_profiles
  WHERE discord_user_id = '<snowflake>';                 -- a user's token balance
SELECT * FROM credit_ledger ORDER BY id DESC LIMIT 30;   -- recent grants/spends/refunds
SELECT kind, sum(delta) FROM credit_ledger
  WHERE created_at > now() - interval '1 day' GROUP BY kind;  -- daily credit flow
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Bot offline after deploy | Bad env, failed migration, or bad token | `journalctl -u characterly -n 100` — crash-loop reason is printed at boot |
| `ECONNRESET` to Supabase | Session-pooler hiccup / idle drop | Usually transient — postgres.js reconnects; if persistent, check Supabase status and pooler mode |
| Messages not extracted | `jobs` backing up or dead-lettered | `SELECT * FROM jobs WHERE attempts >= 5`, then `npx tsx scripts/requeue-dead-jobs.mjs` (`GUILD_ID` optional) after fixing the cause |
| Companion silent in a guild | LLM budget exhausted | `/status` shows today's usage vs `llm_daily_cap`; BudgetExceeded reschedules jobs to UTC midnight |
| Guild dormant out of nowhere | `guild_keys` row undecryptable or removed | Log line `guild_keys decrypt failed` — scope goes dormant until a key is re-set |
| Website OAuth/ magic links fail | Redirect allowlist missing the origin | Add `https://<origin>/**` under Auth → URL Configuration (see [website.md](website.md)) |
| "Link Discord" button errors | Manual linking disabled | Auth → Sign In/Providers → allow manual linking |
| Users get "out of tokens" / capacity notice | Credits spent or `hosted:global` breaker tripped | Balance: `credit_ledger` query above; breaker: `guild_usage` row `hosted:global` vs `HOSTED_DAILY_LLM_CAP` — raise the env var or wait for UTC midnight |
| Companion ignores other companions | `c2c_enabled` off for the replying companion's owner | `SELECT * FROM user_bot_settings WHERE discord_user_id = '<owner snowflake>'` — owner toggles on the dashboard |
| Paid, no tokens/plan | `stripe-webhook` edge fn missing `STRIPE_WEBHOOK_SECRET`, or `grant_pack` rejected | Check Stripe → Developers → Webhooks `we_…` delivery log for the session id; replay the event there. Pack grants dedupe on `credit_ledger.stripe_ref`, so replays are safe. |
| Free users blocked while premium works | `hosted:global` past ~90% of `HOSTED_DAILY_LLM_CAP` | Intended shedding — free lane pauses under fleet pressure. Raise the cap or wait for UTC midnight. |

## Billing (Stripe)

- **Catalog** (live account): `prod_VRhdA8UQOkzj2r` Premium $7.99/mo (`price_1UQoE5GAOUmNDfnhulTyoL1o`); `prod_VRhdvPYT4YwrPt` Token Pack — 500/$4.99 (`price_1UQoE5GAOUmNDfnhwHI9mwm7`), 1,500/$9.99 (`price_1UQoE6GAOUmNDfnh2W16RjDr`), 5,000/$24.99 (`price_1UQoE6GAOUmNDfnh0egnY8GD`). Both carry `txcd_10000000` (SaaS) for Managed Payments.
- **Checkout** is minted by the `create-checkout` edge function (`supabase/functions/create-checkout`) — the dashboard calls it with the user's JWT, it checks `plan` server-side (packs require premium; subscribe requires non-premium) and creates a Checkout Session with `client_reference_id` forced to the caller's account plus `metadata.checkout_kind`. Public payment links are deactivated: they were unguessable-but-forwardable URLs that couldn't gate anything.
- **Secrets**: `create-checkout` needs `STRIPE_SECRET_KEY` (use a **restricted key** scoped to Checkout Sessions write — `rk_live_…`) and `SITE_URL` (the site's origin, used for success/cancel URLs and the CORS allow-origin). `npx supabase secrets set STRIPE_SECRET_KEY=rk_live_… SITE_URL=https://<site> --project-ref tfukkoektmsrolykliop`, then `npx supabase functions deploy create-checkout`. JWT verification stays ON for this function (default; pinned in `supabase/config.toml`).
- **Fulfillment** is the `stripe-webhook` edge function (`supabase/functions/stripe-webhook`, source in repo): verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET` (WebCrypto HMAC-SHA256, 5-min tolerance), then service-role writes `plan`/pack grants. Endpoint `we_1UQoI5GAOUmNDfnhTp1AGDEn` listens for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted` — add `charge.refunded` (audit rows) and optionally `checkout.session.async_payment_failed` (logged) for full coverage.
- **Secret setup**: `STRIPE_WEBHOOK_SECRET` must be set on the edge function — Dashboard → Edge Functions → Secrets, or `npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_… --project-ref tfukkoektmsrolykliop`. The function returns 500 ("not configured") until then, and Stripe retries.
- **`verify_jwt=false`** is pinned in `supabase/config.toml` for `stripe-webhook` — Stripe sends no bearer token. `create-checkout` keeps the default `verify_jwt=true`; don't deploy it with `--no-verify-jwt`.
- **Pack map** is hardcoded twice, keyed differently per function: `create-checkout` maps product name → catalog `price_…`, `stripe-webhook` maps `metadata.checkout_kind` (`PACK_META`) → tokens, with the legacy `PACK_LINKS` payment-link map kept so sessions minted before the switch still classify. New packs need all three + a dashboard button.
- **Error contract**: PostgREST/RPC errors throw → 500 → Stripe retries; only unresolvable or duplicate events ack quietly (and log). supabase-js never throws on DB errors itself — every call goes through `must()`.
- **Plan transitions**: `active`/`trialing` → premium; `canceled`/`unpaid`/`paused`/`incomplete_expired`/deleted → free; `past_due`/`incomplete` keep perks during Stripe's retry window. Deactivation matches only the stored `stripe_subscription_id` — a stale/duplicate sub ending can't strip a plan another sub pays for.

## Secrets & rotation

| Secret | Lives in | Rotation impact |
|--------|----------|-----------------|
| `DISCORD_TOKEN` | VM `.env` | None besides restart. **Do not commit** — rotate in the Developer Portal if it ever leaks (it has appeared in chat history; treat as compromised-adjacent until rotated). |
| `DATABASE_URL` | VM `.env` | Restart after change; pooler password rotation also rotates the Supabase DB password. |
| `GROQ_API_KEY` | VM `.env` | Operator fallback key only — BYOK users unaffected. |
| `KEY_ENCRYPTION_SECRET` | VM `.env` | **Rotating orphans every `guild_keys` row** — users must re-run `/companion action:key`. |
| Supabase service-role key | website worker secret (`SUPABASE_SERVICE_ROLE_KEY`) | Publishable key only in `website/src/config.js` (safe by design — RLS enforces); the service key is server-side only, used by `/discord/events` → `record_app_install`. Rotate via Supabase → API keys, then re-set the worker secret (dashboard → Variables and Secrets, or the per-secret API `PUT` in the install-greeting runbook below). |
| `DISCORD_APP_PUBLIC_KEY` | website worker secret | App's public key (dev portal → General Information) — verifies Discord's signed webhook events. Rotates with the app key; not secret-grade but required for the endpoint. |
| `STRIPE_WEBHOOK_SECRET` | Supabase fn secrets | Missing → webhook 500s, Stripe retries; rotating = update endpoint + secret together. |
| `STRIPE_SECRET_KEY` | Supabase fn secrets | Restricted key (`rk_live_…`, Checkout Sessions write only). Rotate in Stripe → Developers → API keys; no session flow works until re-set. |
| `SITE_URL` | Supabase fn secrets | Checkout return URLs + CORS origin for `create-checkout`. |
| GitHub deploy secrets | repo settings | `ORACLE_SSH_KEY` rotation = update the secret; `ORACLE_HOST_KEY` must be refreshed if the VM is rebuilt. |

## Scheduled work (in-process)

- **Job worker** — `LISTEN`/`NOTIFY` + 3s poll; per-guild serial, global cap 8, 10-min claim lease, dead-letter at 5 attempts.
- **Nightly maintenance** — retention purge, memory lifecycle, verification/dedup, event maintenance, profile rebuilds, journal prune, pair-analysis enqueue.
- **15-min sweep** — missed-signal triage reconciliation (`repairQueuedMarks`), embedding backfill (bounded batch of NULL-embedding memories/journal rows per tick).

Ops utilities (run via `npx tsx scripts/<name>.mjs` with env loaded): `maintain.mjs`, `build-profiles.mjs`, `verify-memories.mjs`, `contest-sweep.mjs`, `backfill-relationships.mjs`, `purge-nonopted.mjs` (**destructive — `PURGE_CONFIRM=1`**), `requeue-dead-jobs.mjs`.

## Companion marketplace (v34)

Listings live in a **forum channel in the hub Discord server**. One-time setup:

1. Create a forum channel in the hub server; grant the bot `Create Public Threads` (and `Manage Threads` if you want unpublish to archive threads).
2. Set `MARKETPLACE_CHANNEL_ID=<forum channel id>` in the VM `.env` and restart — unset disables `/companion action:publish` and hides the surface.
3. Optional: `MARKETPLACE_MOD_CHANNEL_ID=<text channel id>` — gets a ping on every listing report, with **Keep up / Delist / Ban listing / Ban creator** action buttons gated to `MARKETPLACE_MOD_ROLE_IDS` (ManageGuild members can always act).

Related env (defaults are sane): `ADOPTION_COOLDOWN_MS=43200000` (12h re-adopt cooldown), `FREE_ADOPTION_SLOTS=1` (Premium is uncapped in code), `FREE_LISTING_SLOTS=2` (live listings per free account — Premium uncapped), `MARKETPLACE_REPORT_FLAG_THRESHOLD=3`, `MARKET_PUBLISH_DAILY_CAP=5` / `MARKET_REPORT_DAILY_CAP=20` / `MARKET_ADOPT_DAILY_CAP=20` (per-UTC-day rate limits), `SAFETY_MODEL` (defaults to `GROQ_MODEL` — the listing/reply classifier).

Moderation policy + runbook (freeze SQL, unban, audit): `docs/moderation.md`.

## Install greeting (v47) — Discord Webhook Events

Users who add the app *to their account* get a welcome DM automatically (no user-first-message needed). Flow: Discord → `POST https://<site>/discord/events` (website worker, Ed25519-verified) → `record_app_install` RPC → `app_installs` → bot sweep DMs the `onboard:start` card (~20s cadence, permanent `greeted_at` dedupe).

One-time setup — **deploy order matters** (Discord health-checks the URL when you save it):

1. Set the three worker secrets. `cf workers secrets bulk` silently no-ops in the beta and Wrangler needs its own auth — the reliable paths are the **dashboard** (Workers → `characterly-website` → Settings → Variables and Secrets → + Add, type `Secret`) or a per-secret API `PUT`:
   - `DISCORD_APP_PUBLIC_KEY` — the app's **Public Key** from dev portal → General Information (Ed25519 verify).
   - `SUPABASE_URL` — `https://tfukkoektmsrolykliop.supabase.co`.
   - `SUPABASE_SERVICE_ROLE_KEY` — service key stays server-side only.
   ```bash
   # API path (uses cf's stored OAuth token — run per secret):
   PUT https://api.cloudflare.com/client/v4/accounts/<acct>/workers/scripts/characterly-website/secrets
   { "name": "DISCORD_APP_PUBLIC_KEY", "text": "<value>", "type": "secret_text" }
   ```
   Verify with `cf workers secrets list --worker characterly-website` — should show all three names.
2. `npm run deploy` — ships `website/worker.ts` (assets still serve; only `/discord/events` hits the worker code).
3. Dev portal → **General Information → Webhooks** → set **Webhook Events URL** to `https://<site-domain>/discord/events` and save. Discord probes it with deliberately invalid signatures — **401 is the correct answer**; a 2xx to a bad sig gets the endpoint removed.

Slash-command registration now tags install contexts (`scopedCommandDefinitions`): DM-safe commands are invocable in the App DM on user installs; server-only commands stay guild-scoped. No portal action needed beyond the URL — but note user installs only grant the `applications.commands` scope, so anything needing a bot scope stays guild-side.

Failure modes: send errors record `attempts`/`last_error` and retry ≤5 (~20s apart); a missing `DISCORD_APP_PUBLIC_KEY` fails the endpoint closed (401); a missing Supabase secret 500s so Discord retries delivery rather than losing the install.

## Semantic recall (v40) — embeddings via local Ollama

Memories and journal entries carry `vector` columns powering the semantic recall legs (`semanticMemories`, `semanticJournal`) — paraphrase-aware retrieval alongside the lexical legs. The feature is **opt-in**: unset `EMBED_BASE_URL` disables it cleanly.

One-time setup on the VM:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull all-minilm          # ~45MB, 384-dim MiniLM-L6
ollama list                     # verify the model landed
```

Then in `~/characterly/.env`: `EMBED_BASE_URL=http://127.0.0.1:11434/v1` (defaults cover model/dims/key) and `systemctl restart characterly`. The first 15-min sweep tick starts backfilling the existing corpus — watch the `embed.backfilled` counter and `embed.error`/`embed.backfill_error` in `/ops logs`. New saves embed inline at persist time.

- **Hosted alternative** — `EMBED_BASE_URL=https://api.openai.com/v1`, `EMBED_MODEL=text-embedding-3-small`, `EMBED_API_KEY=sk-…`, `EMBED_DIMS=1536`. Same code path (any OpenAI-compatible endpoint works: vLLM, LM Studio, Together).
- **`EMBED_MAX_DISTANCE=0.55`** — cosine-distance ceiling for semantic hits. Raise toward 0.65 if semantic recall rarely fires on live traffic; lower if off-topic memories dilute prompts.
- **Model change caveat** — switching `EMBED_MODEL` to a *different dimensionality* leaves stale vectors that must be cleared or queries error: `UPDATE memories SET embedding=NULL; UPDATE companion_journal SET embedding=NULL;` — the next sweep re-embeds everything with the new model. Same-dim swaps need no clear.
- **RAM** — all-minilm idles under ~300MB; confirm headroom on the free tier (`free -h`).

Moderation state is all in Postgres — `companion_listings.status` (`active`/`flagged`/`delisted`) and `listing_reports`. Delisting/unlisting is a status flip, so it can be done by SQL if the bot is down: `UPDATE companion_listings SET status='delisted' WHERE id=<listing>` blocks new Adds immediately. Existing adopters keep their companions either way.

## Rollback

```bash
cd ~/characterly
git revert HEAD && git push          # or: git reset --hard <good-sha> && git push --force-with-lease
```

The deploy job re-runs on the new push. If a migration was applied by the bad version, migrations don't auto-rollback — inspect `schema_migrations` and either fix-forward or run `runMigrations(sql, targetVersion)` manually via `npx tsx` to roll down.
