# Characterly — dev notes

## Build

`npm run build` compiles `src/` to `dist/` via `tsconfig.build.json` (tests + `test-helpers.ts` excluded; `allowImportingTsExtensions` is dev-only because `stripe-webhook.test.ts` imports a Deno `.ts` edge function). `npm start` runs `node --enable-source-maps dist/index.js` — **not** tsx. Both deploy paths (CI ssh + `/ops deploy`) run `npm ci && npm run build && npm prune --omit=dev` before restart; tsx stays in `dependencies` for the `ops:*` scripts, which import `src/*.ts` directly.

## Tests

`npm test` — the suite includes DB-backed tests that only run when `TEST_DATABASE_URL` is set.

- The `.env` `TEST_DATABASE_URL` points at the Supabase pooler (`aws-0-eu-west-1.pooler.supabase.com`) — it is frequently unreachable (ECONNRESET) and turns the memory/facts tests into 20s timeouts.
- **Preferred:** the local Docker test DB `charly-testdb` (`pgvector/pgvector:pg16`), exposed on `127.0.0.1:54399`, db `characterly_test`. `src/migrations.ts` creates the full schema (incl. `vector`/`pg_trgm` extensions) on plain Postgres — no migration files needed.
- To run against it:
  ```bash
  export TEST_DATABASE_URL="postgres://postgres:$(docker inspect charly-testdb --format '{{range .Config.Env}}{{println .}}{{end}}' | grep POSTGRES_PASSWORD | cut -d= -f2)@127.0.0.1:54399/characterly_test"
  npm test
  ```
- If the container is gone, recreate: `docker run -d --name charly-testdb -e POSTGRES_PASSWORD=<pw> -e POSTGRES_DB=characterly_test -p 127.0.0.1:54399:5432 pgvector/pgvector:pg16`

## Billing

- Edge functions live under `supabase/functions/` and deploy via `npx supabase functions deploy <name> --project-ref tfukkoektmsrolykliop` — or, when the CLI isn't authed, the Supabase MCP `deploy_edge_function` tool (pass file contents; keep `verify_jwt`: `stripe-webhook`→false, `create-checkout`→true).
- Tokens are two buckets (v60): `credit_balance` is the total, `purchased_balance` the persistent pack/bonus slice; only the allowance (`total − purchased`) refills daily. `grant_pack`/`clawback_pack` take extra args (`p_payment_intent`, `p_kind`, refund amounts) — **deploy order: bot first (applies v60), then `stripe-webhook`, then the website** (the dashboard selects `purchased_balance`).
- Stripe catalog lives on the `stripe` MCP (account `acct_1UQa85GAOUmNDfnh`, live). Prices/products are managed there; the ids are mirrored in `create-checkout`/`stripe-webhook` constants and `docs/operations.md` → Billing.

## Partner deployments (multi-server marketplace, v59)

- `guild_deployments` = per-server registry (house synthesized from env); `listing_posts` = the mirror map (nullable `thread_id` — failed rows use NULL, never `""`); `companion_adoptions.chat_guild_id` homes adoptee threads (NULL = house, lazy relocation back when the host dies).
- `MARKET_DEPLOY_ENABLED=1` is the master switch — off refuses `/ops deploygrant`, `/marketplace deploy`, and the sync sweep. `/marketplace` is guild-scoped, registered only in granted servers.
- Flow: `/ops deploygrant <guild_id>` → partner admin runs `/marketplace deploy` (requires Community mode + bot perms) → idempotent category/`#characters` forum/`#adoptees` layout → catalog backfill. `/ops deploystatus|deployrevoke` inspect/undo.
- Everything fans out by tag NAME (ids differ per forum); delist/ban archive every mirror. Details: `docs/marketplace.md` → Partner deployments.

## Prompt hygiene (injection hardening)

- **Every** member- or third-party-authored string must pass a `src/prompt-safety.ts` helper before entering an LLM prompt — never interpolate raw. `promptInline` for values (single-line guarantee), `promptName` for speaker/label positions (reserved names → fallback, markup stripped), `sanitizeBlock` + `wrapUntrusted` for inherently multi-line tool/web output, `sanitizeJsonValue` for JSON evidence payloads.
- Pipeline prompts (extract/verify/triage/dossier/onboarding) append the shared `MEMBER_TEXT_IS_DATA` clause in `brain.ts`; the reply prompt adds the KNOWLEDGE & PRIVACY contract plus lane rules (VAULT RULE server-side, DIGEST RULE for the server→DM digest).
- At the storage boundary: `learnAlias` rejects reserved names, `upsertMember`/companion-name writes strip invisible/format chars via `sanitizeStoredName`.
- Adversarial coverage lives in `src/prompt-injection.test.ts` (structure guarantees, digest edge-consent, storage rejects). The digest relays member edges only with `share_facts_with_companion_owners` consent.

## Auth emails

- Branded templates live in `supabase/templates/` (confirm / magic-link / recovery) and are referenced from `config.toml` for local dev. On the hosted project they're pasted into Dashboard → Authentication → Email Templates — keep the two in sync when editing.
- Sending goes through custom SMTP (Resend) in Dashboard → Auth → SMTP Settings; the default Supabase SMTP is dev-grade (shared pool, ~30/hr, poor deliverability).
