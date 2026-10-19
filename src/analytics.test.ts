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
