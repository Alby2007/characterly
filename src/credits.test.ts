import "dotenv/config";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { makeStore, makeTestSql } from "./test-helpers.js";
import { MemoryStore } from "./database.js";

// Hosted credits live on web_profiles — a table the auth-gated migrations only
// create on Supabase. On plain test Postgres we stand the same columns up as a
// fixture so spendCredits/refundCredits/userBotSettings exercise real SQL.
// Grants are injected via initCreditsSupport so tests don't depend on env.

const GRANTS = { freeDaily: 30, premiumDaily: 150 };

// Fixture tables must not leak into other test files sharing this DB — e.g.
// credit_ledger's FK would block migration rollback tests that drop web_profiles.
after(async () => {
  const sql = makeTestSql();
  await sql`DROP TABLE IF EXISTS credit_ledger, web_profiles`;
  await sql.end();
});

async function fixture(sql: ReturnType<typeof makeTestSql>) {
  await sql`
    CREATE TABLE IF NOT EXISTS web_profiles (
      id                  UUID PRIMARY KEY,
      display_name        TEXT,
      discord_user_id     TEXT UNIQUE,
      discord_username    TEXT,
      discord_avatar_url  TEXT,
      plan                TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','premium')),
      credit_balance      INT NOT NULL DEFAULT 0,
      last_daily_grant_on DATE,
      last_weekly_grant_on DATE,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      account_id    UUID NOT NULL REFERENCES web_profiles(id) ON DELETE CASCADE,
      delta         INT NOT NULL,
      kind          TEXT NOT NULL,
      reason        TEXT,
      stripe_ref    TEXT,
      balance_after INT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  const { store } = await makeStore(sql);
  assert.equal(await store.initCreditsSupport(GRANTS), true);
  return store;
}

async function addAccount(sql: ReturnType<typeof makeTestSql>, discordUserId: string, plan = "free", balance = 0) {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO web_profiles (id, discord_user_id, plan, credit_balance)
    VALUES (gen_random_uuid(), ${discordUserId}, ${plan}, ${balance})
    RETURNING id
  `;
  return rows[0].id;
}

test("creditsSupported is false without web_profiles and degrades gracefully", async () => {
  const sql = makeTestSql();
  const { store } = await makeStore(sql);
  await sql`DROP TABLE IF EXISTS credit_ledger`;
  await sql`DROP TABLE IF EXISTS web_profiles`;
  assert.equal(await store.initCreditsSupport(GRANTS), false);
  // Self-host lane: everyone reads as premium, spends always succeed.
  const acct = await store.accountForDiscordUser("u-nobody");
  assert.equal(acct?.plan, "premium");
  assert.deepEqual(await store.spendCredits("u-nobody", 5, "x"), { ok: true, balance: 0 });
  assert.deepEqual(await store.userBotSettings("u-nobody"), { c2cEnabled: true, lowCreditAlerts: true });
  await sql.end();
});

test("accountForDiscordUser returns null for unlinked and the row for linked", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  assert.equal(await store.accountForDiscordUser("u-stranger"), null);
  const id = await addAccount(sql, "u-alice", "free", 7);
  const acct = await store.accountForDiscordUser("u-alice");
  assert.equal(acct?.id, id);
  assert.equal(acct?.creditBalance, 7);
  await sql.end();
});

test("tosAcceptance/recordTosAcceptance round-trip; highest version wins", async () => {
  const sql = makeTestSql();
  const { store } = await makeStore(sql);
  assert.equal(await store.tosAcceptance("u-nobody"), null, "no rows ⇒ null");
  await store.recordTosAcceptance("u-alice", null, 1, "discord_verify");
  assert.equal((await store.tosAcceptance("u-alice"))?.version, 1);
  // A newer acceptance is a second row — the audit trail keeps both, the
  // lookup returns the highest version.
  await store.recordTosAcceptance("u-alice", "acc-uuid", 2, "web_signup");
  const latest = await store.tosAcceptance("u-alice");
  assert.equal(latest?.version, 2);
  assert.ok(latest?.acceptedAt);
  const rows = await sql`SELECT count(*)::int AS n FROM consent_events WHERE discord_user_id = 'u-alice'`;
  assert.equal(rows[0].n, 2, "both acceptances stay on the audit trail");
  await sql.end();
});

test("tosAcceptance matches web-signup rows via account_id", async () => {
  const sql = makeTestSql();
  const { store } = await makeStore(sql);
  // A web signup predates Discord linking — NULL discord_user_id, account only.
  await sql`
    INSERT INTO consent_events (discord_user_id, account_id, document, version, source)
    VALUES (NULL, 'acc-web', 'terms', 1, 'web_signup')
  `;
  // The same person, now linked on Discord — the account row counts.
  assert.equal((await store.tosAcceptance("u-bob", "acc-web"))?.version, 1);
  // Without the account hint the web row doesn't match his Discord id…
  assert.equal(await store.tosAcceptance("u-bob"), null);
  // …and it never leaks to a different account.
  assert.equal(await store.tosAcceptance("u-eve", "acc-other"), null);
  // A stale web acceptance (v1) plus a current Discord one (v2) — highest wins.
  await store.recordTosAcceptance("u-bob", "acc-web", 2, "discord_verify");
  assert.equal((await store.tosAcceptance("u-bob", "acc-web"))?.version, 2);
  await sql.end();
});

test("first spend applies the daily grant lazily, then debits", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await addAccount(sql, "u-alice");
  const r = await store.spendCredits("u-alice", 2, "dm_turn");
  assert.equal(r.ok, true);
  assert.equal(r.balance, GRANTS.freeDaily - 2);
  const ledger = await sql`SELECT kind, delta, balance_after FROM credit_ledger ORDER BY id`;
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].kind, "grant_daily");
  assert.equal(ledger[0].delta, GRANTS.freeDaily);
  assert.equal(ledger[1].kind, "spend");
  assert.equal(ledger[1].delta, -2);
  await sql.end();
});

test("the daily grant only lands once per UTC day", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await addAccount(sql, "u-alice");
  await store.spendCredits("u-alice", 2, "a");
  const r = await store.spendCredits("u-alice", 3, "b");
  assert.equal(r.balance, GRANTS.freeDaily - 5);
  const grants = await sql`SELECT count(*)::int AS n FROM credit_ledger WHERE kind = 'grant_daily'`;
  assert.equal(grants[0].n, 1);
  await sql.end();
});

test("premium refills to the 150/day floor — single grant, no weekly bucket", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await addAccount(sql, "u-vip", "premium");
  const r = await store.spendCredits("u-vip", 2, "dm_turn");
  assert.equal(r.balance, GRANTS.premiumDaily - 2);
  const ledger = await sql`SELECT kind, delta FROM credit_ledger ORDER BY id`;
  assert.deepEqual(ledger.map(l => l.kind), ["grant_daily", "spend"]);
  assert.equal(Number(ledger[0].delta), GRANTS.premiumDaily);
  await sql.end();
});

test("purchaseCredits adds pack tokens idempotently on stripe_ref", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_stripe_ref ON credit_ledger (stripe_ref) WHERE stripe_ref IS NOT NULL`;
  const accountId = await addAccount(sql, "u-buyer", "free", 10);
  const r = await store.purchaseCredits(accountId, 500, "pack_500", "cs_test_1");
  assert.deepEqual(r, { ok: true, duplicate: false, balance: 510 });
  // Webhook redelivery lands on the unique stripe_ref — no double grant.
  const dup = await store.purchaseCredits(accountId, 500, "pack_500", "cs_test_1");
  assert.deepEqual(dup, { ok: true, duplicate: true, balance: 510 });
  const rows = await sql`SELECT count(*)::int AS n FROM credit_ledger WHERE kind = 'purchase'`;
  assert.equal(rows[0].n, 1);
  await sql.end();
});

test("hostedUsageToday reads the hosted:global counter for today only", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  assert.equal(await store.hostedUsageToday(), 0);
  await sql`INSERT INTO guild_usage (guild_id, day, llm_calls) VALUES ('hosted:global', (now() AT TIME ZONE 'UTC')::date, 42)`;
  assert.equal(await store.hostedUsageToday(), 42);
  await sql`INSERT INTO guild_usage (guild_id, day, llm_calls) VALUES ('hosted:global', (now() AT TIME ZONE 'UTC')::date - 1, 999) ON CONFLICT DO NOTHING`;
  assert.equal(await store.hostedUsageToday(), 42, "yesterday's row doesn't count");
  await sql.end();
});

test("refill never pushes a balance past the grant floor", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await addAccount(sql, "u-alice", "free", 100);
  // Balance already above the daily grant — no grant row lands, spend debits only.
  const r = await store.spendCredits("u-alice", 2, "dm_turn");
  assert.equal(r.balance, 98);
  const ledger = await sql`SELECT kind FROM credit_ledger ORDER BY id`;
  assert.deepEqual(ledger.map(l => l.kind), ["spend"]);
  // But the day's grant is still marked consumed.
  const rows = await sql`SELECT last_daily_grant_on FROM web_profiles WHERE discord_user_id = 'u-alice'`;
  assert.ok(rows[0].last_daily_grant_on);
  await sql.end();
});

test("concurrent spends serialize on the account row lock — never overspend", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await addAccount(sql, "u-alice"); // refills to 30 on first spend
  // Two parallel spends of 20: exactly one may win; the loser sees the
  // post-grant balance of 10 and fails instead of driving the account negative.
  const [a, b] = await Promise.all([
    store.spendCredits("u-alice", 20, "one"),
    store.spendCredits("u-alice", 20, "two"),
  ]);
  const wins = [a, b].filter(r => r.ok);
  assert.equal(wins.length, 1, "exactly one concurrent spend may succeed");
  assert.equal(wins[0].balance, GRANTS.freeDaily - 20);
  const loser = [a, b].find(r => !r.ok)!;
  assert.equal(loser.balance, GRANTS.freeDaily - 20, "loser sees the debited balance, not a stale one");
  const rows = await sql`SELECT credit_balance FROM web_profiles WHERE discord_user_id = 'u-alice'`;
  assert.equal(Number(rows[0].credit_balance), GRANTS.freeDaily - 20);
  await sql.end();
});

test("purchaseCredits on a missing account fails closed, no ledger row", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_stripe_ref ON credit_ledger (stripe_ref) WHERE stripe_ref IS NOT NULL`;
  const r = await store.purchaseCredits("3f2f4b0e-9b1a-4f5c-8d6e-7a8b9c0d1e2f", 500, "pack_500", "cs_ghost");
  assert.deepEqual(r, { ok: false, duplicate: false, balance: 0 });
  const n = await sql`SELECT count(*)::int AS n FROM credit_ledger`;
  assert.equal(n[0].n, 0);
  await sql.end();
});

test("refundCredits on an unlinked user fails closed", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  assert.deepEqual(await store.refundCredits("u-ghost", 1, "x"), { ok: false, balance: 0 });
  await sql.end();
});

test("insufficient balance fails but keeps the grant it applied", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await addAccount(sql, "u-alice");
  const r = await store.spendCredits("u-alice", 50, "too_much");
  assert.equal(r.ok, false);
  assert.equal(r.balance, GRANTS.freeDaily);
  const rows = await sql`SELECT credit_balance FROM web_profiles WHERE discord_user_id = 'u-alice'`;
  assert.equal(Number(rows[0].credit_balance), GRANTS.freeDaily);
  await sql.end();
});

test("spend on an unlinked user fails closed", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  assert.deepEqual(await store.spendCredits("u-ghost", 2, "dm_turn"), { ok: false, balance: 0 });
  await sql.end();
});

test("refundCredits credits back and writes a refund ledger row", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await addAccount(sql, "u-alice");
  await store.spendCredits("u-alice", 2, "dm_turn");
  const r = await store.refundCredits("u-alice", 1, "dm_turn_refund");
  assert.equal(r.ok, true);
  assert.equal(r.balance, GRANTS.freeDaily - 1);
  const last = await sql`SELECT kind, delta, reason FROM credit_ledger ORDER BY id DESC LIMIT 1`;
  assert.equal(last[0].kind, "refund");
  assert.equal(last[0].delta, 1);
  assert.equal(last[0].reason, "dm_turn_refund");
  await sql.end();
});

test("userBotSettings defaults then persists toggles", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  assert.deepEqual(await store.userBotSettings("u-alice"), { c2cEnabled: true, lowCreditAlerts: true });
  await sql`INSERT INTO user_bot_settings (discord_user_id, c2c_enabled, low_credit_alerts) VALUES ('u-alice', false, false)`;
  // Fresh instance — the settings cache is deliberately 60s-stale in prod.
  const fresh = await MemoryStore.create(sql as any);
  await fresh.initCreditsSupport(GRANTS);
  assert.deepEqual(await fresh.userBotSettings("u-alice"), { c2cEnabled: false, lowCreditAlerts: false });
  await sql.end();
});
