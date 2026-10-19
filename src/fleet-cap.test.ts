import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { computeFleetBonus, createFleetCap, type FleetCapConfig } from "./fleet-cap.js";
import { makeStore, makeTestSql } from "./test-helpers.js";

// Revenue-aware fleet cap — the formula must be conservative by construction
// (floor, ceiling, zero-guards) and the provider must never let a bad read
// sink the cap below the static base. The DB test needs the web_profiles
// fixture; formula/provider tests are pure.
const dbTest = { skip: !process.env.TEST_DATABASE_URL };

const CFG: FleetCapConfig = {
  baseDailyCap: 20_000,
  premiumDailyRevenueUsd: 0.22,
  costPerHostedCallUsd: 0.0005,
  safetyFactor: 0.5,
  maxBonusCalls: 60_000,
};

// ── computeFleetBonus — the pure formula ─────────────────────────────────────

test("computeFleetBonus: zero and negative premium counts fund nothing", () => {
  assert.equal(computeFleetBonus(0, CFG), 0);
  assert.equal(computeFleetBonus(-5, CFG), 0);
  assert.equal(computeFleetBonus(NaN, CFG), 0);
});

test("computeFleetBonus: 50 subs fund ~11k calls at conservative defaults", () => {
  // floor(50 * 0.22 / 0.0005 * 0.5) = floor(11000)
  assert.equal(computeFleetBonus(50, CFG), 11_000);
  assert.equal(computeFleetBonus(1, CFG), 220);
});

test("computeFleetBonus: safety factor scales the funded calls linearly", () => {
  assert.equal(computeFleetBonus(50, { ...CFG, safetyFactor: 1 }), 22_000);
  assert.equal(computeFleetBonus(50, { ...CFG, safetyFactor: 0.25 }), 5_500);
});

test("computeFleetBonus: the absolute ceiling clamps a huge sub count", () => {
  assert.equal(computeFleetBonus(100_000, CFG), 60_000);
  assert.equal(computeFleetBonus(50, { ...CFG, maxBonusCalls: 5_000 }), 5_000);
});

test("computeFleetBonus: non-positive inputs or config yield zero bonus", () => {
  assert.equal(computeFleetBonus(50, { ...CFG, costPerHostedCallUsd: 0 }), 0);
  assert.equal(computeFleetBonus(50, { ...CFG, costPerHostedCallUsd: -1 }), 0);
  assert.equal(computeFleetBonus(50, { ...CFG, premiumDailyRevenueUsd: 0 }), 0);
  assert.equal(computeFleetBonus(50, { ...CFG, safetyFactor: 0 }), 0);
  assert.equal(computeFleetBonus(50, { ...CFG, maxBonusCalls: 0 }), 0);
});

// ── createFleetCap — cache, ratchet, failure paths ───────────────────────────

function fakeStore(count: { n: number; used?: number; throws?: boolean }) {
  const state = { calls: 0 };
  return {
    state,
    premiumAccountCount: async () => {
      state.calls++;
      if (count.throws) throw new Error("db down");
      return count.n;
    },
    hostedUsageToday: async () => count.used ?? 0,
  };
}

function makeCap(store: ReturnType<typeof fakeStore>, nowRef: { t: number }, cfg = CFG) {
  return createFleetCap({ store, cfg, now: () => nowRef.t });
}

test("getEffective: base + bonus, cached for the TTL without re-querying", async () => {
  const store = fakeStore({ n: 50 });
  const t0 = Date.UTC(2025, 0, 15, 12);
  const nowRef = { t: t0 };
  const cap = makeCap(store, nowRef);

  assert.equal(await cap.getEffective(), 31_000);
  assert.equal(await cap.getEffective(), 31_000);
  assert.equal(store.state.calls, 1);

  nowRef.t += 59_000;
  assert.equal(await cap.getEffective(), 31_000);
  assert.equal(store.state.calls, 1);

  nowRef.t += 2_000; // past the 60s TTL
  assert.equal(await cap.getEffective(), 31_000);
  assert.equal(store.state.calls, 2);
});

test("getEffective: concurrent callers share one refresh", async () => {
  const store = fakeStore({ n: 10 });
  const nowRef = { t: Date.UTC(2025, 0, 15, 12) };
  const cap = makeCap(store, nowRef);
  const [a, b, c] = await Promise.all([cap.getEffective(), cap.getEffective(), cap.getEffective()]);
  assert.equal(a, b); assert.equal(b, c);
  assert.equal(store.state.calls, 1);
});

test("ratchet: intraday drops hold; growth applies immediately; resets next UTC day", async () => {
  const count = { n: 50 };
  const store = fakeStore(count);
  const nowRef = { t: Date.UTC(2025, 0, 15, 12) };
  const cap = makeCap(store, nowRef);

  assert.equal(await cap.getEffective(), 31_000);

  // Cancellations mid-day: the cap must not shrink below committed spend.
  count.n = 10;
  nowRef.t += 61_000;
  assert.equal(await cap.getEffective(), 31_000);

  // New subs mid-day: growth applies on the next refresh.
  count.n = 100;
  nowRef.t += 61_000;
  assert.equal(await cap.getEffective(), 42_000);

  // UTC midnight: the day-boundary reset recomputes from the live count.
  nowRef.t = Date.UTC(2025, 0, 16, 0, 1);
  count.n = 10;
  assert.equal(await cap.getEffective(), 22_200);
});

test("a premium-count failure falls back to the base cap, never below", async () => {
  const count = { n: 0, throws: true };
  const store = fakeStore(count);
  const nowRef = { t: Date.UTC(2025, 0, 15, 12) };
  const cap = makeCap(store, nowRef);
  assert.equal(await cap.getEffective(), 20_000);
});

test("a mid-day premium-count failure keeps the day's ratcheted cap", async () => {
  const count = { n: 50, throws: false };
  const store = fakeStore(count);
  const nowRef = { t: Date.UTC(2025, 0, 15, 12) };
  const cap = makeCap(store, nowRef);
  assert.equal(await cap.getEffective(), 31_000);

  count.throws = true;
  nowRef.t += 61_000;
  assert.equal(await cap.getEffective(), 31_000);
});

test("a frozen fleet (base = 0) stays frozen regardless of subs", async () => {
  const store = fakeStore({ n: 500 });
  const nowRef = { t: Date.UTC(2025, 0, 15, 12) };
  const cap = makeCap(store, nowRef, { ...CFG, baseDailyCap: 0 });
  assert.equal(await cap.getEffective(), 0);
});

test("current() returns base before the first refresh, effective after", async () => {
  const store = fakeStore({ n: 50 });
  const nowRef = { t: Date.UTC(2025, 0, 15, 12) };
  const cap = makeCap(store, nowRef);
  assert.equal(cap.current(), 20_000);
  await cap.getEffective();
  assert.equal(cap.current(), 31_000);
});

test("describe() reports the full breakdown", async () => {
  const store = fakeStore({ n: 50, used: 12_340 });
  const nowRef = { t: Date.UTC(2025, 0, 15, 12) };
  const cap = makeCap(store, nowRef);
  const bd = await cap.describe();
  assert.deepEqual(bd, {
    base: 20_000, bonus: 11_000, computed: 31_000, effective: 31_000,
    premiumCount: 50, usedToday: 12_340, maxBonus: 60_000,
  });
});

test("describe() exposes the ratchet hold — computed drops, effective holds", async () => {
  const count = { n: 50 };
  const store = fakeStore(count);
  const nowRef = { t: Date.UTC(2025, 0, 15, 12) };
  const cap = makeCap(store, nowRef);
  await cap.getEffective();

  count.n = 10; // cancellations mid-day: formula yields 22,200, cap holds 31,000
  nowRef.t += 61_000;
  const bd = await cap.describe();
  assert.equal(bd.bonus, 2_200);
  assert.equal(bd.computed, 22_200);
  assert.equal(bd.effective, 31_000);
});

// ── premiumAccountCount — the DB-backed revenue signal ───────────────────────

test("premiumAccountCount counts only plan='premium' web_profiles rows", dbTest, async () => {
  const sql = makeTestSql();
  try {
    // Same fixture shape as credits.test.ts — web_profiles only exists where
    // the Supabase schema was applied.
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
    const { store } = await makeStore(sql);
    assert.equal(await store.initCreditsSupport({ freeDaily: 30, premiumDaily: 150 }), true);

    assert.equal(await store.premiumAccountCount(), 0);
    await sql`INSERT INTO web_profiles (id, discord_user_id, plan) VALUES (gen_random_uuid(), 'u1', 'free')`;
    await sql`INSERT INTO web_profiles (id, discord_user_id, plan) VALUES (gen_random_uuid(), 'u2', 'premium')`;
    await sql`INSERT INTO web_profiles (id, discord_user_id, plan) VALUES (gen_random_uuid(), 'u3', 'premium')`;
    await sql`INSERT INTO web_profiles (id, discord_user_id, plan) VALUES (gen_random_uuid(), 'u4', 'free')`;
    assert.equal(await store.premiumAccountCount(), 2);
  } finally {
    await sql.end();
  }
});

test("premiumAccountCount returns 0 when the credits schema is absent", dbTest, async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Without initCreditsSupport / a web_profiles probe, credits stay
    // unsupported and the count short-circuits — the provider then sees 0
    // subs and the cap stays at base.
    assert.equal(await store.premiumAccountCount(), 0);
  } finally {
    await sql.end();
  }
});
