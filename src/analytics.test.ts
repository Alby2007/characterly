import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";

const dbTest = { skip: !process.env.TEST_DATABASE_URL };

test("trackEvent inserts rows; opt-out gates inserts and wipes history; opt-in restores", dbTest, async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.trackEvent("u1", "onboard_start");
    await store.trackEvent("u1", "awaken");
    await store.trackEvent(null, "guild_added", "g1");
    let rows = await sql`SELECT event FROM analytics_events ORDER BY id`;
    assert.equal(rows.length, 3);

    await store.setAnalyticsOptOut("u1", true);
    rows = await sql`SELECT id FROM analytics_events WHERE discord_user_id = 'u1'`;
    assert.equal(rows.length, 0, "opt-out wipes the user's event rows");
    const guildRow = await sql`SELECT event FROM analytics_events WHERE discord_user_id IS NULL`;
    assert.equal(guildRow.length, 1, "guild-level rows survive a user opt-out");

    await store.trackEvent("u1", "summon", "g1");
    rows = await sql`SELECT id FROM analytics_events WHERE discord_user_id = 'u1'`;
    assert.equal(rows.length, 0, "the opt-out gate blocks new inserts");

    await store.setAnalyticsOptOut("u1", false);
    await store.trackEvent("u1", "summon", "g1");
    rows = await sql`SELECT event FROM analytics_events WHERE discord_user_id = 'u1'`;
    assert.equal(rows.length, 1, "opt-in re-enables tracking");
  } finally { await sql.end(); }
});

test("a trackEvent racing setAnalyticsOptOut cannot leak a post-wipe row", dbTest, async () => {
  const sql = makeTestSql();
  const other = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // A second session holds the user's advisory key so both writers queue
    // behind it — then whatever acquires it first, the outcome must be 0 rows.
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const lockHeld = new Promise<void>(r => { acquired = r; });
    const holding = other.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('u-race', 0))`;
      acquired();
      await gate;
    });
    await lockHeld;
    try {
      const insertP = store.trackEvent("u-race", "awaken");
      // Prove the insert really waits on the lock — without it the row would
      // already be visible, and the post-wipe guarantee would be unchecked.
      await new Promise(r => setTimeout(r, 150));
      const mid = await sql`SELECT id FROM analytics_events WHERE discord_user_id = 'u-race'`;
      assert.equal(mid.length, 0, "insert queues behind the held advisory lock");
      // Now queue the opt-out behind the same lock and release. If the insert
      // wins its row lands pre-flag and the DELETE must wipe it; if the opt-out
      // wins, NOT EXISTS blocks the insert. Either way: zero.
      const optOutP = store.setAnalyticsOptOut("u-race", true);
      release();
      await Promise.all([insertP, optOutP]);
    } finally {
      release();
      await holding.catch(() => {});
    }
    const rows = await sql`SELECT id FROM analytics_events WHERE discord_user_id = 'u-race'`;
    assert.equal(rows.length, 0, "no analytics row may survive a completed opt-out");
  } finally { await sql.end(); await other.end(); }
});

test("a trackEvent blocked behind a committing opt-out still sees the flag", dbTest, async () => {
  const sql = makeTestSql();
  const other = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // The queue-behind-a-bare-lock test above always grants the insert first
    // (advisory waits are FIFO), so it never exercises "opt-out wins". The
    // dangerous ordering needs the flag+delete tx holding the key while the
    // insert's statement starts — fixing its READ COMMITTED snapshot before
    // the flag commits. setAnalyticsOptOut can't be held open mid-tx, so this
    // replays its exact statements under the same key on a second session.
    let release!: () => void, acquired!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const held = new Promise<void>(r => (acquired = r));
    const optTx = other.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('u-race2', 0))`;
      await tx`INSERT INTO user_bot_settings (discord_user_id, analytics_opt_out) VALUES ('u-race2', true)
               ON CONFLICT (discord_user_id) DO UPDATE SET analytics_opt_out = true, updated_at = now()`;
      await tx`DELETE FROM analytics_events WHERE discord_user_id = 'u-race2'`;
      acquired();
      await gate;
    });
    await held;
    const insertP = store.trackEvent("u-race2", "awaken");
    // The insert must be provably blocked on the lock — not merely slow — so
    // its statement snapshot predates the flag commit. Poll pg_stat_activity
    // for the advisory wait rather than sleeping a fixed interval.
    let blocked = false;
    for (let i = 0; i < 40 && !blocked; i++) {
      const w = await sql`SELECT 1 FROM pg_stat_activity
                          WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
                            AND query LIKE '%pg_advisory_xact_lock%'`;
      if (w.length) { blocked = true; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(blocked, "insert never reached the advisory-lock wait");
    release();
    await Promise.all([insertP, optTx.catch(() => {})]);
    const rows = await sql`SELECT id FROM analytics_events WHERE discord_user_id = 'u-race2'`;
    assert.equal(rows.length, 0, "an insert that waited behind the opt-out must see its flag");
  } finally { await sql.end(); await other.end(); }
});

test("flushMetricDeltas accumulates into the daily rollup", dbTest, async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.flushMetricDeltas({ "a.b": 3, "c.d": 1 });
    await store.flushMetricDeltas({ "a.b": 2 });
    await store.flushMetricDeltas({});
    const rows = await sql`SELECT name, count FROM metrics_daily ORDER BY name`;
    assert.deepEqual(rows.map(r => [r.name, Number(r.count)]), [["a.b", 5], ["c.d", 1]]);
  } finally { await sql.end(); }
});

test("purgeGuild clears guild-scoped analytics rows but keeps its own tombstone", dbTest, async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.trackEvent("u1", "summon", "g-dead");
    await store.purgeGuild("g-dead");
    const rows = await sql`SELECT event, scope FROM analytics_events ORDER BY id`;
    assert.deepEqual(rows.map(r => r.event), ["guild_purged"], "the summon row died with the guild; the tombstone landed after");
  } finally { await sql.end(); }
});

test("pruneAnalyticsEvents drops only rows past the window", dbTest, async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.trackEvent("u1", "awaken");
    await sql`UPDATE analytics_events SET created_at = now() - interval '401 days'`;
    assert.equal(await store.pruneAnalyticsEvents(400), 1);
    const rows = await sql`SELECT id FROM analytics_events`;
    assert.equal(rows.length, 0);
    await store.trackEvent("u1", "awaken");
    assert.equal(await store.pruneAnalyticsEvents(400), 0, "fresh rows survive");
  } finally { await sql.end(); }
});

test("opsStats returns shaped aggregates — funnel counts distinct users", dbTest, async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.trackEvent("u1", "onboard_start");
    await store.trackEvent("u1", "onboard_start"); // re-prompt — inflates events, not users
    await store.trackEvent("u1", "awaken");
    await store.trackEvent("u2", "onboard_start");
    await store.trackEvent(null, "guild_added", "g1");
    await store.trackEvent(null, "guild_added", "g2");
    await store.trackEvent(null, "guild_purged", "g1");
    await store.flushMetricDeltas({ "install.greeted": 4 });
    const s = await store.opsStats();
    assert.equal(s.funnel["onboard_start"].users, 2, "distinct users drive conversion rates");
    assert.equal(s.funnel["onboard_start"].events, 3, "raw count still reflects re-prompts");
    assert.equal(s.funnel["awaken"].users, 1);
    // Guild-level events carry no user id — the scope is their actor.
    assert.equal(s.funnel["guild_added"].users, 2, "null-user events count distinct scopes");
    assert.equal(s.funnel["guild_purged"].users, 1);
    assert.deepEqual(s.topCounters[0], { name: "install.greeted", total: 4 });
    assert.ok(s.dauDm >= 0 && s.dauGuilds >= 0 && s.wauDm >= 0 && s.wauGuilds >= 0);
    assert.equal(s.tokens, null, "no credit schema on the test DB → tokens surface is absent");
  } finally { await sql.end(); }
});
