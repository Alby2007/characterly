import "dotenv/config";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { makeStore, makeTestSql } from "./test-helpers.js";
import { MemoryStore } from "./database.js";
import { migrations } from "./migrations.js";

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
      refunded_of   BIGINT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE web_profiles ADD COLUMN IF NOT EXISTS purchased_balance INT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE web_profiles ADD COLUMN IF NOT EXISTS creator_slug TEXT`;
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
  assert.deepEqual(await store.spendCredits("u-nobody", 5, "x"), { ok: true, balance: 0, purchased: 0 });
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

test("grantBonus credits the purchased slice exactly once per ref", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_stripe_ref ON credit_ledger (stripe_ref) WHERE stripe_ref IS NOT NULL`;
  const accountId = await addAccount(sql, "u-mig", "free", 30);

  const g1 = await store.grantBonus("u-mig", 150, "migration_bonus", "migration-bonus:u-mig");
  assert.deepEqual(g1, { ok: true, duplicate: false, balance: 180 });
  const acct = await store.accountForDiscordUser("u-mig");
  assert.equal(acct?.creditBalance, 180);
  assert.equal(acct?.purchasedBalance, 150, "bonus is the persistent slice — refills don't eat it");

  // Same ref → the unique index absorbs it: ledger stays at one row.
  const g2 = await store.grantBonus("u-mig", 150, "migration_bonus", "migration-bonus:u-mig");
  assert.deepEqual(g2, { ok: true, duplicate: true, balance: 180 });
  const rows = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM credit_ledger WHERE account_id = ${accountId}`;
  assert.equal(rows[0].n, 1);
  const row = await sql<Array<{ kind: string; reason: string; delta: number }>>`
    SELECT kind, reason, delta FROM credit_ledger WHERE stripe_ref = 'migration-bonus:u-mig'`;
  assert.equal(row[0].kind, "grant_bonus");
  assert.equal(row[0].reason, "migration_bonus");
  assert.equal(row[0].delta, 150);

  // Concurrent triggers serialize on the account row + index — exactly once.
  await addAccount(sql, "u-mig2", "free", 0);
  const pair = await Promise.all([
    store.grantBonus("u-mig2", 150, "migration_bonus", "migration-bonus:u-mig2"),
    store.grantBonus("u-mig2", 150, "migration_bonus", "migration-bonus:u-mig2"),
  ]);
  assert.equal(pair.filter(r => r.ok && !r.duplicate).length, 1);
  assert.equal(pair.filter(r => r.duplicate).length, 1);

  // Unlinked user fails closed — no row, no balance.
  assert.deepEqual(await store.grantBonus("u-ghost", 150, "migration_bonus", "migration-bonus:u-ghost"),
    { ok: false, duplicate: false, balance: 0 });

  // Bad amounts fail closed too — a zero/negative grant would junk the
  // ledger and burn the dedupe ref for the real one later.
  assert.deepEqual(await store.grantBonus("u-mig", 0, "migration_bonus", "migration-bonus:u-mig-z"),
    { ok: false, duplicate: false, balance: 0 });
  assert.deepEqual(await store.grantBonus("u-mig", -50, "migration_bonus", "migration-bonus:u-mig-n"),
    { ok: false, duplicate: false, balance: 0 });
  assert.equal((await sql`SELECT count(*)::int AS n FROM credit_ledger WHERE account_id = ${accountId}`)[0].n, 1);
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
  assert.deepEqual(await store.spendCredits("u-ghost", 2, "dm_turn"), { ok: false, balance: 0, purchased: 0 });
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

async function setBuckets(sql: ReturnType<typeof makeTestSql>, discordUserId: string, total: number, purchased: number) {
  await sql`UPDATE web_profiles SET credit_balance = ${total}, purchased_balance = ${purchased} WHERE discord_user_id = ${discordUserId}`;
}
async function buckets(sql: ReturnType<typeof makeTestSql>, discordUserId: string) {
  const [r] = await sql`SELECT credit_balance, purchased_balance FROM web_profiles WHERE discord_user_id = ${discordUserId}`;
  return { total: Number(r.credit_balance), purchased: Number(r.purchased_balance) };
}

test("a pack never suppresses the daily refill — allowance tops up beside it", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_stripe_ref ON credit_ledger (stripe_ref) WHERE stripe_ref IS NOT NULL`;
  const id = await addAccount(sql, "u-vip", "premium", 0);
  await store.purchaseCredits(id, 750, "pack_750", "cs_bucket_1");
  assert.deepEqual(await buckets(sql, "u-vip"), { total: 750, purchased: 750 });
  // First spend of the day: the full 150 allowance lands on top of the pack.
  const r = await store.spendCredits("u-vip", 2, "dm_turn");
  assert.equal(r.ok, true);
  assert.equal(r.purchased, 0, "allowance is spent before the pack");
  assert.deepEqual(await buckets(sql, "u-vip"), { total: 750 + GRANTS.premiumDaily - 2, purchased: 750 });
  await sql.end();
});

test("spend drains the allowance first, then the pack; refund returns to the bucket it left", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await addAccount(sql, "u-alice", "free", 0);
  await sql`UPDATE web_profiles SET last_daily_grant_on = (now() AT TIME ZONE 'UTC')::date WHERE discord_user_id = 'u-alice'`;
  await setBuckets(sql, "u-alice", 101, 100); // 1 allowance + 100 pack
  const r = await store.spendCredits("u-alice", 2, "dm_turn");
  assert.deepEqual(r, { ok: true, balance: 99, purchased: 1 });
  assert.deepEqual(await buckets(sql, "u-alice"), { total: 99, purchased: 99 });
  await store.refundCredits("u-alice", 2, "dm_turn_refund", r.purchased);
  assert.deepEqual(await buckets(sql, "u-alice"), { total: 101, purchased: 100 });
  await sql.end();
});

test("allowance debt is paid down by the grant, not erased", async () => {
  const sql = makeTestSql();
  const store = await fixture(sql);
  await addAccount(sql, "u-debtor", "free", 0);
  await setBuckets(sql, "u-debtor", -50, 0); // clawed pack already spent
  const r = await store.spendCredits("u-debtor", 2, "dm_turn");
  assert.equal(r.ok, false, "a 30 grant against −50 debt still leaves nothing to spend");
  assert.deepEqual(await buckets(sql, "u-debtor"), { total: -50 + GRANTS.freeDaily, purchased: 0 });
  await sql.end();
});

// The RPCs live behind the auth-schema gate — stand up a throwaway `auth`
// schema so the real v60 SQL runs, then tear it down so no later test file
// sees an auth-gated database.
test("v60 grant_pack / clawback_pack: exact payment_intent match, proration, bonus never clawed", async () => {
  const sql = makeTestSql();
  await fixture(sql);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_stripe_ref ON credit_ledger (stripe_ref) WHERE stripe_ref IS NOT NULL`;
  await sql`CREATE SCHEMA IF NOT EXISTS auth`;
  try {
    await migrations.find(m => m.version === 60)!.up(sql as never);
    const id = await addAccount(sql, "u-buyer", "premium", 0);
    const grant = (args: Record<string, unknown>) => sql`SELECT public.grant_pack(${id}::uuid, ${args.tokens as number}, ${args.ref as string}, ${(args.pi as string) ?? null}, ${(args.kind as string) ?? "purchase"}) AS r`.then(r => r[0].r);
    const claw = (charge: string, pi: string | null, amount: number | null, refunded: number | null, at: string | null = null) =>
      sql`SELECT public.clawback_pack(${id}::uuid, ${charge}, ${pi}, ${amount}, ${refunded}, ${at}::timestamptz) AS r`.then(r => r[0].r);

    await grant({ tokens: 7500, ref: "cs_big", pi: "pi_big" });
    await grant({ tokens: 750, ref: "cs_small", pi: "pi_small" });
    await grant({ tokens: 500, ref: "launch-bonus:x", kind: "grant_bonus" });
    assert.deepEqual(await buckets(sql, "u-buyer"), { total: 8750, purchased: 8750 });

    // Subscription refund (no matching PI, no charged_at) claws nothing.
    assert.equal((await claw("ch_sub", "pi_sub", 799, 799)).clawed, 0);
    assert.equal((await buckets(sql, "u-buyer")).total, 8750);

    // Refunding the BIG pack hits the big pack, not the newest one; half refund ⇒ half claw.
    assert.equal((await claw("ch_big", "pi_big", 2499, 1250)).clawed, 3752);
    // Redelivery of the same partial refund is a no-op.
    assert.equal((await claw("ch_big", "pi_big", 2499, 1250)).duplicate, true);
    // The rest of the refund claws only the remainder.
    assert.equal((await claw("ch_big", "pi_big", 2499, 2499)).clawed, 7500 - 3752);
    assert.deepEqual(await buckets(sql, "u-buyer"), { total: 1250, purchased: 1250 });

    const bonus = await sql`SELECT kind, reason FROM credit_ledger WHERE stripe_ref = 'launch-bonus:x'`;
    assert.deepEqual({ ...bonus[0] }, { kind: "grant_bonus", reason: "launch_bonus" });
    const pi = await sql`SELECT payment_intent FROM credit_ledger WHERE stripe_ref = 'cs_small'`;
    assert.equal(pi[0].payment_intent, "pi_small");
  } finally {
    await sql`DROP FUNCTION IF EXISTS public.grant_pack(uuid, int, text, text, text)`;
    await sql`DROP FUNCTION IF EXISTS public.clawback_pack(uuid, text, text, int, int, timestamptz)`;
    await sql`DROP SCHEMA IF EXISTS auth CASCADE`;
    await sql.end();
  }
});

// v71: claim_daily_grant applies spendCredits' lazy refill on read — the
// dashboard calls it so a balance display can't lag the spendable reality.
// auth.uid() is stubbed from a tx-local setting; the gate + schema get torn
// down so later test files see a plain database again.
test("v71 claim_daily_grant: fill on read, idempotent, mirrors spendCredits math", async () => {
  const sql = makeTestSql();
  await fixture(sql);
  await sql`CREATE SCHEMA IF NOT EXISTS auth`;
  await sql`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $s$ SELECT nullif(current_setting('app.claim_uid', true), '')::uuid $s$`;
  const claim = (id: string | null) => sql.begin(async tx => {
    await tx`SELECT set_config('app.claim_uid', ${id ?? ""}, true)`;
    const r = await tx`SELECT public.claim_daily_grant() AS r`;
    return r[0].r;
  });
  try {
    await migrations.find(m => m.version === 71)!.up(sql as never);

    // Never-spent free account: 0 raw → 30 after claim, marker stamped, ledger written.
    const fresh = await addAccount(sql, "u-fresh", "free", 0);
    let res = await claim(fresh);
    assert.equal(res.credit_balance, 30);
    assert.equal(res.purchased_balance, 0);
    const ledger = await sql`SELECT kind, delta, balance_after FROM credit_ledger WHERE account_id = ${fresh}`;
    assert.deepEqual(ledger.map(l => ({ ...l, balance_after: Number(l.balance_after) })), [{ kind: "grant_daily", delta: 30, balance_after: 30 }]);
    const marker = await sql`SELECT last_daily_grant_on FROM web_profiles WHERE id = ${fresh}`;
    assert.ok(marker[0].last_daily_grant_on, "marker stamped");

    // Same-day second claim is a no-op — no double grant.
    res = await claim(fresh);
    assert.equal(res.credit_balance, 30);
    assert.equal((await sql`SELECT count(*)::int c FROM credit_ledger WHERE account_id = ${fresh}`)[0].c, 1);

    // Stale marker + drained allowance: tops back up to the floor.
    await sql`UPDATE web_profiles SET credit_balance = 4, last_daily_grant_on = current_date - 1 WHERE id = ${fresh}`;
    res = await claim(fresh);
    assert.equal(res.credit_balance, 30);

    // The purchased slice never suppresses the refill: 25 pack tokens + 0 allowance → +30.
    const packed = await addAccount(sql, "u-packed", "free", 25);
    await sql`UPDATE web_profiles SET purchased_balance = 25, last_daily_grant_on = current_date - 1 WHERE id = ${packed}`;
    res = await claim(packed);
    assert.deepEqual({ t: res.credit_balance, p: res.purchased_balance }, { t: 55, p: 25 });

    // Clawback debt: a −50 allowance gets the full 30 paid down, not topped to floor.
    const debtor = await addAccount(sql, "u-debtor", "free", -50);
    await sql`UPDATE web_profiles SET last_daily_grant_on = current_date - 1 WHERE id = ${debtor}`;
    res = await claim(debtor);
    assert.equal(res.credit_balance, -20);

    // Premium floor is 150.
    const prem = await addAccount(sql, "u-prem", "premium", 0);
    res = await claim(prem);
    assert.equal(res.credit_balance, 150);

    // No profile row → zeros, not an error. No auth → the function raises.
    res = await claim("00000000-0000-0000-0000-000000000099");
    assert.deepEqual({ t: res.credit_balance, p: res.purchased_balance }, { t: 0, p: 0 });
    await assert.rejects(claim(null), /not authenticated/);
  } finally {
    await sql`DROP FUNCTION IF EXISTS public.claim_daily_grant()`;
    await sql`DROP SCHEMA IF EXISTS auth CASCADE`;
    await sql.end();
  }
});

// v72: creator_slug_available feeds the dashboard's live address check —
// same auth stub + migration-up pattern as v71.
test("v72 creator_slug_available: taken, reserved, invalid, own", async () => {
  const sql = makeTestSql();
  await fixture(sql);
  await sql`CREATE SCHEMA IF NOT EXISTS auth`;
  await sql`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $s$ SELECT nullif(current_setting('app.claim_uid', true), '')::uuid $s$`;
  const check = (uid: string | null, slug: string) => sql.begin(async tx => {
    await tx`SELECT set_config('app.claim_uid', ${uid ?? ""}, true)`;
    const r = await tx`SELECT public.creator_slug_available(${slug}) AS r`;
    return r[0].r;
  });
  try {
    await migrations.find(m => m.version === 72)!.up(sql as never);
    const owner = await addAccount(sql, "u-owner");
    await sql`UPDATE web_profiles SET creator_slug = 'night-forge' WHERE id = ${owner}`;
    const other = await addAccount(sql, "u-other");

    assert.deepEqual(await check(other, "night-forge"), { available: false, reason: "taken", slug: "night-forge" });
    assert.equal((await check(owner, "night-forge")).available, true, "own slug reads free");
    assert.deepEqual(await check(other, "Admin"), { available: false, reason: "reserved", slug: "admin" });
    assert.equal((await check(other, "has space")).reason, "invalid");
    assert.equal((await check(other, "ab")).reason, "invalid");
    assert.deepEqual(await check(other, "  Free-Name  "), { available: true, slug: "free-name" });
    await assert.rejects(check(null, "anything-ok"), /not authenticated/);
  } finally {
    await sql`DROP FUNCTION IF EXISTS public.creator_slug_available(text)`;
    await sql`DROP SCHEMA IF EXISTS auth CASCADE`;
    await sql.end();
  }
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
