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

## Database access

Supabase dashboard → SQL Editor, or `psql "$DATABASE_URL"`. The bot connects as `postgres` (bypasses RLS). Useful checks:

```sql
SELECT * FROM schema_migrations ORDER BY version;          -- migration state (latest: 31)
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
- **Checkout** is Stripe Payment Links — zero backend for purchase. Dashboard appends `?client_reference_id=<web_profiles.id>&prefilled_email=<email>`.
- **Fulfillment** is the `stripe-webhook` edge function (`supabase/functions/stripe-webhook`, source in repo): verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET` (WebCrypto HMAC-SHA256, 5-min tolerance), then service-role writes `plan`/pack grants. Endpoint `we_1UQoI5GAOUmNDfnhTp1AGDEn` listens for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`.
- **Secret setup**: `STRIPE_WEBHOOK_SECRET` must be set on the edge function — Dashboard → Edge Functions → Secrets, or `npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_… --project-ref tfukkoektmsrolykliop`. The function returns 500 ("not configured") until then, and Stripe retries.
- **Pack→link map** is hardcoded in the function (`PACK_LINKS`) — new packs need a new link + map entry + redeploy.
- **Plan transitions**: `active`/`trialing` → premium; `canceled`/`deleted` → free; `past_due`/`unpaid` leave plan alone during Stripe's retry window.

## Secrets & rotation

| Secret | Lives in | Rotation impact |
|--------|----------|-----------------|
| `DISCORD_TOKEN` | VM `.env` | None besides restart. **Do not commit** — rotate in the Developer Portal if it ever leaks (it has appeared in chat history; treat as compromised-adjacent until rotated). |
| `DATABASE_URL` | VM `.env` | Restart after change; pooler password rotation also rotates the Supabase DB password. |
| `GROQ_API_KEY` | VM `.env` | Operator fallback key only — BYOK users unaffected. |
| `KEY_ENCRYPTION_SECRET` | VM `.env` | **Rotating orphans every `guild_keys` row** — users must re-run `/companion action:key`. |
| Supabase service-role key | nowhere in the repo/site | Publishable key only in `website/src/config.js` (safe by design — RLS enforces). |
| GitHub deploy secrets | repo settings | `ORACLE_SSH_KEY` rotation = update the secret; `ORACLE_HOST_KEY` must be refreshed if the VM is rebuilt. |

## Scheduled work (in-process)

- **Job worker** — `LISTEN`/`NOTIFY` + 3s poll; per-guild serial, global cap 8, 10-min claim lease, dead-letter at 5 attempts.
- **Nightly maintenance** — retention purge, memory lifecycle, verification/dedup, event maintenance, profile rebuilds, journal prune, pair-analysis enqueue.
- **15-min sweep** — missed-signal triage reconciliation (`repairQueuedMarks`).

Ops utilities (run via `npx tsx scripts/<name>.mjs` with env loaded): `maintain.mjs`, `build-profiles.mjs`, `verify-memories.mjs`, `contest-sweep.mjs`, `backfill-relationships.mjs`, `purge-nonopted.mjs` (**destructive — `PURGE_CONFIRM=1`**), `requeue-dead-jobs.mjs`.

## Rollback

```bash
cd ~/characterly
git revert HEAD && git push          # or: git reset --hard <good-sha> && git push --force-with-lease
```

The deploy job re-runs on the new push. If a migration was applied by the bad version, migrations don't auto-rollback — inspect `schema_migrations` and either fix-forward or run `runMigrations(sql, targetVersion)` manually via `npx tsx` to roll down.
