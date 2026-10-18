# Characterly — dev notes

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
- Stripe catalog lives on the `stripe` MCP (account `acct_1UQa85GAOUmNDfnh`, live). Prices/products are managed there; the ids are mirrored in `create-checkout`/`stripe-webhook` constants and `docs/operations.md` → Billing.
