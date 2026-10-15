import "dotenv/config";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { makeStore, makeTestSql } from "./test-helpers.js";
import { MemoryStore } from "./database.js";

// Hosted credits live on web_profiles — a table the auth-gated migrations only
// create on Supabase. On plain test Postgres we stand the same columns up as a
// fixture so spendCredits/refundCredits/userBotSettings exercise real SQL.
// Grants are injected via initCreditsSupport so tests don't depend on env.

const GRANTS = { freeDaily: 20, premiumDaily: 30, premiumWeekly: 300 };

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

test("premium gets the daily top-up plus the weekly grant", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await addAccount(sql, "u-vip", "premium");
  const r = await store.spendCredits("u-vip", 2, "dm_turn");
  assert.equal(r.balance, GRANTS.premiumDaily + GRANTS.premiumWeekly - 2);
  const kinds = (await sql`SELECT kind FROM credit_ledger ORDER BY id`).map(r2 => r2.kind);
  assert.deepEqual(kinds, ["grant_daily", "grant_weekly", "spend"]);
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
