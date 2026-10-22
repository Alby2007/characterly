import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { runMigrations, getMigrationVersion, LATEST_MIGRATION_VERSION } from "./migrations.js";

// ── Test DB connection ─────────────────────────────────────────────────────────
// Tests require TEST_DATABASE_URL to be set to a Postgres DB.
// Each test gets a fresh schema by dropping all tables first.

function makeTestSql() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for migration tests");
  return postgres(url, { max: 3, onnotice: () => {} });
}

/** Drop all public-schema tables so each test starts fresh. Dynamic so the
 * list can't go stale as migrations add tables — leftover rows from other
 * test files (e.g. marketplace listings) must not leak into rollback tests. */
async function resetSchema(sql: ReturnType<typeof postgres>) {
  await sql`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
      END LOOP;
    END $$
  `;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("migrations create schema_migrations table", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_migrations'`;
    assert.equal(rows.length, 1);
  } finally { await sql.end(); }
});

test("migrations are applied in order", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const version = await getMigrationVersion(sql as any);
    assert.equal(version, LATEST_MIGRATION_VERSION);
  } finally { await sql.end(); }
});

test("migrations are idempotent", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const firstVersion = await getMigrationVersion(sql as any);
    await runMigrations(sql as any);
    const secondVersion = await getMigrationVersion(sql as any);
    assert.equal(firstVersion, secondVersion);
  } finally { await sql.end(); }
});

test("migration adds expected columns to memories table", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='memories'`;
    const cols = rows.map(r => r.column_name);
    for (const col of ["confirmation_count", "contradiction_count", "updated_at", "last_contradicted_at", "supersedes_memory_id"]) {
      assert.ok(cols.includes(col), `Missing column: ${col}`);
    }
  } finally { await sql.end(); }
});

test("migration adds expected columns to memory_evidence table", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='memory_evidence'`;
    const cols = rows.map(r => r.column_name);
    for (const col of ["evidence_type", "effect", "message_content_snapshot", "message_timestamp", "created_at"]) {
      assert.ok(cols.includes(col), `Missing column: ${col}`);
    }
  } finally { await sql.end(); }
});

test("migration creates memory_history table", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='memory_history'`;
    assert.equal(rows.length, 1);
  } finally { await sql.end(); }
});

test("migration creates expected indexes", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname='public'`;
    const names = rows.map(r => r.indexname);
    assert.ok(names.includes("memory_history_lookup"), "Missing index: memory_history_lookup");
  } finally { await sql.end(); }
});

test("migration version tracking works correctly", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any, 1);
    assert.equal(await getMigrationVersion(sql as any), 1);
    const rows = await sql<Array<{ version: number }>>`SELECT version FROM schema_migrations ORDER BY version`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].version, 1);
  } finally { await sql.end(); }
});

test("migration v2 adds net_score, frozen_confidence, and pattern_id columns to memories", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='memories'`;
    const cols = rows.map(r => r.column_name);
    for (const col of ["net_score", "frozen_confidence", "pattern_id"]) {
      assert.ok(cols.includes(col), `Missing column: ${col}`);
    }
  } finally { await sql.end(); }
});

test("migration v2 creates behavioral_patterns table with expected columns", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='behavioral_patterns'`;
    assert.equal(tables.length, 1);
    const rows = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='behavioral_patterns'`;
    const cols = rows.map(r => r.column_name);
    for (const col of ["guild_id", "subject_id", "description", "episode_count", "confidence", "status"]) {
      assert.ok(cols.includes(col), `Missing column: ${col}`);
    }
  } finally { await sql.end(); }
});

test("migration v2 creates patterns_lookup index", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname='public'`;
    assert.ok(rows.some(r => r.indexname === "patterns_lookup"), "Missing index: patterns_lookup");
  } finally { await sql.end(); }
});

test("migrations can be applied incrementally", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any, 1);
    assert.equal(await getMigrationVersion(sql as any), 1);
    await runMigrations(sql as any, 2);
    assert.equal(await getMigrationVersion(sql as any), 2);
    await runMigrations(sql as any, 3);
    assert.equal(await getMigrationVersion(sql as any), 3);
  } finally { await sql.end(); }
});

test("rolling back to v1 removes behavioral_patterns table and index", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    assert.equal(await getMigrationVersion(sql as any), LATEST_MIGRATION_VERSION);
    await runMigrations(sql as any, 1);
    assert.equal(await getMigrationVersion(sql as any), 1);
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='behavioral_patterns'`;
    assert.equal(tables.length, 0, "behavioral_patterns should be gone after rollback");
  } finally { await sql.end(); }
});

test("migration v3 adds primary_evidence_type column to memories", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='memories'`;
    assert.ok(rows.some(r => r.column_name === "primary_evidence_type"), "Missing column: primary_evidence_type");
  } finally { await sql.end(); }
});

test("migration v4 creates events, event_participants, event_messages, event_memories tables", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`;
    const names = rows.map(r => r.table_name);
    for (const name of ["events", "event_participants", "event_messages", "event_memories"]) {
      assert.ok(names.includes(name), `Missing table: ${name}`);
    }
    const cols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='memories'`;
    assert.ok(cols.some(c => c.column_name === "event_id"), "memories.event_id column missing");
  } finally { await sql.end(); }
});

test("migration v4 creates expected indexes", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname='public'`;
    const names = rows.map(r => r.indexname);
    for (const name of ["events_guild_channel", "events_guild_open", "event_participants_event", "event_messages_event", "event_memories_memory", "event_memories_event"]) {
      assert.ok(names.includes(name), `Missing index: ${name}`);
    }
  } finally { await sql.end(); }
});

test("migration v7 creates members, relationship_observations, relationships, profiles tables and reply_to_id column", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`;
    const names = rows.map(r => r.table_name);
    for (const name of ["members", "relationship_observations", "relationships", "profiles"]) {
      assert.ok(names.includes(name), `Missing table: ${name}`);
    }
    const cols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='messages'`;
    assert.ok(cols.some(c => c.column_name === "reply_to_id"), "messages.reply_to_id column missing");
    const memberCols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='members'`;
    const mcols = memberCols.map(r => r.column_name);
    for (const col of ["guild_id", "user_id", "known_names", "first_seen_at", "last_seen_at", "message_count", "opted_out"]) {
      assert.ok(mcols.includes(col), `Missing members column: ${col}`);
    }
  } finally { await sql.end(); }
});

test("migration v12 creates profile_attributes + profiles.attr_hash, rolls back cleanly", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const cols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='profile_attributes'`;
    const names = cols.map(c => c.column_name);
    for (const col of ["guild_id", "subject_id", "field", "value", "value_norm", "confidence", "memory_ids", "status", "superseded_by", "first_seen_at", "last_seen_at"]) {
      assert.ok(names.includes(col), `Missing column: ${col}`);
    }
    const profileCols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='profiles'`;
    assert.ok(profileCols.some(c => c.column_name === "attr_hash"), "profiles.attr_hash missing");
    // Create-only: no rows are written by the migration itself.
    const count = await sql<[{ n: number }]>`SELECT COUNT(*)::int AS n FROM profile_attributes`;
    assert.equal(count[0].n, 0);

    await runMigrations(sql as any, 11);
    const tables = await sql<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='profile_attributes'`;
    assert.equal(tables.length, 0, "profile_attributes should be dropped on rollback");
    const remaining = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='profiles' AND column_name='attr_hash'`;
    assert.equal(remaining.length, 0, "attr_hash should be dropped on rollback");
  } finally { await sql.end(); }
});

test("migration v14 adds members.opted_in, rolls back cleanly", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const cols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='members'`;
    assert.ok(cols.some(c => c.column_name === "opted_in"), "members.opted_in missing");

    await runMigrations(sql as any, 13);
    const remaining = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='members' AND column_name='opted_in'`;
    assert.equal(remaining.length, 0, "opted_in should be dropped on rollback");
  } finally { await sql.end(); }
});

test("migration v15 creates guild_keys, rolls back cleanly", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const cols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='guild_keys'`;
    const names = cols.map(c => c.column_name);
    for (const col of ["key_enc", "key_hint", "base_url", "validated_at", "created_at", "updated_at"]) {
      assert.ok(names.includes(col), `guild_keys.${col} missing`);
    }
    // No plaintext key column may exist — ciphertext only.
    assert.ok(!names.includes("api_key") && !names.includes("key"), "no plaintext key column");

    await runMigrations(sql as any, 14);
    const tables = await sql<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_name='guild_keys'`;
    assert.equal(tables.length, 0, "guild_keys should be dropped on rollback");
  } finally { await sql.end(); }
});

test("migration v16 flips observe defaults to dormant and adds announced_at", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const defaults = await sql<Array<{ column_name: string; column_default: string | null }>>`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'server_settings' AND column_name IN ('memory_enabled', 'reply_enabled', 'announced_at')
    `;
    const byName = Object.fromEntries(defaults.map(d => [d.column_name, d.column_default]));
    assert.equal(byName.memory_enabled, "0", "memory_enabled should default to dormant");
    assert.equal(byName.reply_enabled, "0", "reply_enabled should default to dormant");
    assert.ok("announced_at" in byName, "announced_at column missing");

    // Existing rows keep their explicit values — only the DEFAULT changed.
    await sql`INSERT INTO server_settings (guild_id, memory_enabled, reply_enabled) VALUES ('g-explicit', 1, 1)`;
    const kept = await sql`SELECT memory_enabled, reply_enabled FROM server_settings WHERE guild_id = 'g-explicit'`;
    assert.equal(Number(kept[0].memory_enabled), 1);
    assert.equal(Number(kept[0].reply_enabled), 1);

    await runMigrations(sql as any, 15);
    const rolled = await sql<Array<{ column_name: string; column_default: string | null }>>`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'server_settings' AND column_name IN ('memory_enabled', 'announced_at')
    `;
    const rb = Object.fromEntries(rolled.map(d => [d.column_name, d.column_default]));
    assert.equal(rb.memory_enabled, "1", "rollback should restore the observe-by-default default");
    assert.ok(!("announced_at" in rb), "announced_at should be dropped on rollback");
  } finally { await sql.end(); }
});

test("migration v17 creates jobs + guild_usage and the scale-rails columns", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const tables = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('jobs', 'guild_usage')
    `;
    assert.deepEqual(tables.map(t => t.table_name).sort(), ["guild_usage", "jobs"]);

    const cols = await sql<Array<{ column_name: string; column_default: string | null }>>`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'server_settings' AND column_name IN ('ignored_channels', 'llm_daily_cap')
    `;
    const byName = Object.fromEntries(cols.map(d => [d.column_name, d.column_default]));
    assert.ok("ignored_channels" in byName, "ignored_channels column missing");
    assert.ok(byName.llm_daily_cap?.startsWith("1000"), "llm_daily_cap should default to 1000");

    // Functional check: a fresh guild row picks up both defaults.
    await sql`INSERT INTO server_settings (guild_id) VALUES ('g-v17')`;
    const [r] = await sql`SELECT ignored_channels, llm_daily_cap FROM server_settings WHERE guild_id = 'g-v17'`;
    assert.deepEqual(r.ignored_channels, []);
    assert.equal(Number(r.llm_daily_cap), 1000);

    await runMigrations(sql as any, 16);
    const gone = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('jobs', 'guild_usage')
    `;
    assert.equal(gone.length, 0, "rollback should drop both new tables");
    const dropped = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'server_settings' AND column_name IN ('ignored_channels', 'llm_daily_cap')
    `;
    assert.equal(dropped.length, 0, "rollback should drop both new columns");
  } finally { await sql.end(); }
});

test("migration v18 adds author_is_bot and events.classifications, rolls back cleanly", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const cols = await sql<Array<{ table_name: string; column_name: string; column_default: string | null }>>`
      SELECT table_name, column_name, column_default FROM information_schema.columns
      WHERE (table_name = 'messages' AND column_name = 'author_is_bot')
         OR (table_name = 'events' AND column_name = 'classifications')
      ORDER BY table_name
    `;
    assert.equal(cols.length, 2, "both v18 columns must exist");
    const byName = Object.fromEntries(cols.map(c => [c.column_name, c.column_default]));
    assert.equal(byName.author_is_bot, "false");
    assert.equal(byName.classifications, "0");

    // Functional defaults: a fresh row picks up false/0 without explicit values.
    await sql`INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at)
              VALUES ('m-v18', 'g-v18', 'c', 'u', 'n', 'x', now())`;
    const [m] = await sql`SELECT author_is_bot FROM messages WHERE id = 'm-v18'`;
    assert.equal(m.author_is_bot, false);

    await runMigrations(sql as any, 17);
    const gone = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE (table_name = 'messages' AND column_name = 'author_is_bot')
         OR (table_name = 'events' AND column_name = 'classifications')
    `;
    assert.equal(gone.length, 0, "rollback should drop both v18 columns");
  } finally { await sql.end(); }
});

test("migration v19 adds relationship_observations.author_id and backfills from source messages", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any, 18); // stop short of v19 — no author_id yet
    await sql`INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at)
              VALUES ('m-live', 'g1', 'c1', 'u9', 'Zed', 'they are close friends', now())`;
    await sql`INSERT INTO relationship_observations (guild_id, subject_id, other_id, message_id, nature)
              VALUES ('g1', 'u1', 'u2', 'm-live', 'close friends')`;
    await sql`INSERT INTO relationship_observations (guild_id, subject_id, other_id, message_id, nature)
              VALUES ('g1', 'u1', 'u3', 'm-dead', 'rivals')`; // source already gone

    await runMigrations(sql as any); // apply v19
    const rows = await sql<Array<{ message_id: string; author_id: string | null }>>`
      SELECT message_id, author_id FROM relationship_observations ORDER BY message_id`;
    assert.equal(rows.find(r => r.message_id === "m-live")?.author_id, "u9", "backfilled from the source message");
    assert.equal(rows.find(r => r.message_id === "m-dead")?.author_id, null, "dead source stays NULL — provenance already lost");

    await runMigrations(sql as any, 18);
    const cols = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'relationship_observations' AND column_name = 'author_id'`;
    assert.equal(cols.length, 0, "rollback should drop author_id");
  } finally { await sql.end(); }
});

test("migration v20 adds observation source and edge intelligence columns", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const obsCols = await sql<Array<{ column_name: string; column_default: string | null }>>`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'relationship_observations' AND column_name = 'source'`;
    assert.equal(obsCols.length, 1, "relationship_observations.source missing");
    assert.ok(obsCols[0].column_default?.includes("'message'"), "source should default to 'message'");

    const edgeCols = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'relationships'
        AND column_name IN ('behavioral_count', 'party_count', 'trend', 'inferred')`;
    assert.equal(edgeCols.length, 4, "relationships should gain all four edge-intelligence columns");

    // Functional defaults: existing/fresh rows pick up 'message'/0 without writes.
    await sql`INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at)
              VALUES ('m-v20', 'g1', 'c1', 'u1', 'A', 'x', now())`;
    await sql`INSERT INTO relationship_observations (guild_id, subject_id, other_id, message_id, nature)
              VALUES ('g1', 'u1', 'u2', 'm-v20', 'friends')`;
    const [o] = await sql`SELECT source FROM relationship_observations WHERE message_id = 'm-v20'`;
    assert.equal(o.source, "message");

    await runMigrations(sql as any, 19);
    const gone = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE (table_name = 'relationship_observations' AND column_name = 'source')
         OR (table_name = 'relationships' AND column_name IN ('behavioral_count', 'party_count', 'trend', 'inferred'))`;
    assert.equal(gone.length, 0, "rollback should drop all v20 columns");
  } finally { await sql.end(); }
});

test("migration v21 creates companions, guild_companions, and webhook_messages tables and rolls back cleanly", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const tables = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('companions', 'guild_companions', 'webhook_messages')
    `;
    assert.deepEqual(tables.map(t => t.table_name).sort(), ["companions", "guild_companions", "webhook_messages"]);

    await runMigrations(sql as any, 20);
    const gone = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('companions', 'guild_companions', 'webhook_messages')
    `;
    assert.equal(gone.length, 0, "rollback should drop all v21 tables");
  } finally { await sql.end(); }
});

test("migration v29 creates user_bot_settings outside the auth gate and rolls back", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    // Ungated half of v29 — the bot reads settings on plain Postgres too.
    const cols = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'user_bot_settings'
    `;
    assert.deepEqual(
      cols.map(c => c.column_name).sort(),
      // v34 adds active_dm_companion_id on top of the v29 columns; v62 adds analytics_opt_out.
      ["active_dm_companion_id", "analytics_opt_out", "c2c_enabled", "discord_user_id", "low_credit_alerts", "updated_at"],
    );
    const rls = await sql<Array<{ relrowsecurity: boolean }>>`
      SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'user_bot_settings'
    `;
    assert.equal(rls[0]?.relrowsecurity, true, "user_bot_settings must have RLS enabled");

    // Auth-gated objects correctly stay absent on plain Postgres.
    const gated = await sql<Array<{ t: string | null; c: string | null }>>`
      SELECT to_regclass('public.credit_ledger') AS t, to_regclass('public.web_profiles') AS c
    `;
    assert.equal(gated[0].t, null);
    assert.equal(gated[0].c, null);

    await runMigrations(sql as any, 28);
    const gone = await sql`SELECT to_regclass('public.user_bot_settings') AS t`;
    assert.equal(gone[0].t, null, "rollback should drop user_bot_settings");
  } finally { await sql.end(); }
});

test("migration v36 creates the moderation surface and rolls back banned -> flagged", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    // listing_reports.category
    const catCol = await sql<Array<{ column_name: string; column_default: string | null }>>`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'listing_reports' AND column_name = 'category'`;
    assert.equal(catCol.length, 1, "listing_reports.category missing");
    assert.ok(catCol[0].column_default?.includes("'other'"), "category should default to 'other'");

    // marketplace_bans + moderation_events tables/columns.
    const banCols = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'marketplace_bans'`;
    assert.deepEqual(
      banCols.map(c => c.column_name).sort(),
      ["banned_by", "created_at", "discord_user_id", "reason"],
    );
    const evCols = await sql<Array<{ column_name: string; is_nullable: string }>>`
      SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'moderation_events'`;
    const evNames = evCols.map(c => c.column_name).sort();
    assert.deepEqual(evNames, ["action", "actor_user_id", "created_at", "id", "listing_id", "note"]);
    assert.equal(evCols.find(c => c.column_name === "listing_id")?.is_nullable, "YES",
      "moderation_events.listing_id must be nullable (ON DELETE SET NULL)");

    // Indexes that make the per-day rate-limit counts cheap.
    const idx = await sql<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname='public'`;
    const names = idx.map(r => r.indexname);
    for (const n of ["mod_events_listing", "listing_reports_reporter", "listings_creator_created", "adoptions_user_adopted"]) {
      assert.ok(names.includes(n), `Missing index: ${n}`);
    }

    // Seed a banned listing — rollback must convert it to flagged, not leave
    // it in a status the older code can't read.
    await sql`INSERT INTO companion_listings (creator_user_id, name, status) VALUES ('u-v36', 'Banned', 'banned')`;
    await sql`INSERT INTO companion_listings (creator_user_id, name, status) VALUES ('u-v36', 'Fine', 'active')`;
    await sql`INSERT INTO moderation_events (listing_id, actor_user_id, action) VALUES (NULL, 'u-v36', 'ban')`;
    await sql`INSERT INTO marketplace_bans (discord_user_id, banned_by) VALUES ('u-v36', 'mod-1')`;

    await runMigrations(sql as any, 35);
    const statuses = await sql<Array<{ status: string }>>`SELECT status FROM companion_listings ORDER BY name`;
    assert.deepEqual(statuses.map(s => s.status), ["flagged", "active"], "banned should revert to flagged on rollback");
    const gone = await sql<Array<{ t: string | null }>>`
      SELECT to_regclass('public.moderation_events') AS t UNION ALL SELECT to_regclass('public.marketplace_bans')`;
    assert.ok(gone.every(r => r.t === null), "rollback should drop both moderation tables");
    const catGone = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'listing_reports' AND column_name = 'category'`;
    assert.equal(catGone.length, 0, "rollback should drop category");
    const idxGone = await sql<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE schemaname='public'
        AND indexname IN ('mod_events_listing','listing_reports_reporter','listings_creator_created','adoptions_user_adopted')`;
    assert.equal(idxGone.length, 0, "rollback should drop the rate-limit indexes");
  } finally { await sql.end(); }
});

test("migration v37 creates listing_ratings + comment_reports with constraints, rolls back cleanly", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const rateCols = await sql<Array<{ column_name: string; is_nullable: string }>>`
      SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'listing_ratings'`;
    assert.deepEqual(
      rateCols.map(c => c.column_name).sort(),
      ["created_at", "id", "listing_id", "rater_user_id", "stars", "updated_at"],
    );
    const repCols = await sql<Array<{ column_name: string; is_nullable: string }>>`
      SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'comment_reports'`;
    assert.deepEqual(
      repCols.map(c => c.column_name).sort(),
      ["author_user_id", "category", "created_at", "id", "listing_id", "message_id", "reporter_user_id", "thread_id"],
    );
    assert.equal(repCols.find(c => c.column_name === "listing_id")?.is_nullable, "YES",
      "comment_reports.listing_id must be nullable (ON DELETE SET NULL)");

    const idx = await sql<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname='public'`;
    const names = idx.map(r => r.indexname);
    for (const n of ["listing_ratings_listing", "comment_reports_message", "comment_reports_reporter"]) {
      assert.ok(names.includes(n), `Missing index: ${n}`);
    }

    // Functional constraints: one rating per (listing, rater); stars 1–5;
    // one report per (message, reporter); listing_id optional on reports.
    await sql`INSERT INTO companion_listings (creator_user_id, name) VALUES ('u-v37', 'Rated') RETURNING id`;
    const [l] = await sql<[{ id: number }]>`SELECT id FROM companion_listings WHERE creator_user_id = 'u-v37'`;
    await sql`INSERT INTO listing_ratings (listing_id, rater_user_id, stars) VALUES (${l.id}, 'u-r1', 4)`;
    await assert.rejects(
      sql`INSERT INTO listing_ratings (listing_id, rater_user_id, stars) VALUES (${l.id}, 'u-r1', 5)`,
      /unique/i, "second rating row from the same rater must violate UNIQUE",
    );
    await assert.rejects(
      sql`INSERT INTO listing_ratings (listing_id, rater_user_id, stars) VALUES (${l.id}, 'u-r2', 9)`,
      /check/i, "stars outside 1–5 must violate the CHECK",
    );
    // …but the app's upsert path turns the unique conflict into an update.
    await sql`INSERT INTO listing_ratings (listing_id, rater_user_id, stars) VALUES (${l.id}, 'u-r1', 5)
              ON CONFLICT (listing_id, rater_user_id) DO UPDATE SET stars = EXCLUDED.stars, updated_at = NOW()`;
    const [avg] = await sql<[{ n: number }]>`SELECT COUNT(*)::int AS n FROM listing_ratings WHERE listing_id = ${l.id}`;
    assert.equal(avg.n, 1, "upsert keeps one row per rater");

    await sql`INSERT INTO comment_reports (thread_id, message_id, author_user_id, reporter_user_id)
              VALUES ('t1', 'm1', 'u-author', 'u-r1')`;
    await assert.rejects(
      sql`INSERT INTO comment_reports (thread_id, message_id, author_user_id, reporter_user_id)
          VALUES ('t1', 'm1', 'u-author', 'u-r1')`,
      /unique/i, "duplicate report on the same message must violate UNIQUE",
    );
    // Listing-less reports are legal (thread mapping can be lost).
    await sql`INSERT INTO comment_reports (thread_id, message_id, author_user_id, reporter_user_id)
              VALUES ('t1', 'm2', 'u-author', 'u-r1')`;

    await runMigrations(sql as any, 36);
    const gone = await sql<Array<{ t: string | null }>>`
      SELECT to_regclass('public.listing_ratings') AS t UNION ALL SELECT to_regclass('public.comment_reports')`;
    assert.ok(gone.every(r => r.t === null), "rollback should drop both v37 tables");
  } finally { await sql.end(); }
});

test("migration v38 adds the Discord profile snapshot columns to link_codes", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const cols = await sql<Array<{ column_name: string; is_nullable: string }>>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'link_codes' AND column_name IN ('discord_username', 'discord_avatar_url')`;
    assert.equal(cols.length, 2, "link_codes needs both snapshot columns");
    assert.ok(cols.every(c => c.is_nullable === "YES"), "snapshot columns must be nullable — bare mints and old rows");

    // web_profiles discord_* are auth-gated: no auth schema in test Postgres
    // → the columns must NOT appear here (they're created inside the gate).
    const gated = await sql<Array<{ t: string | null }>>`SELECT to_regclass('public.web_profiles') AS t`;
    assert.equal(gated[0].t, null, "web_profiles shouldn't exist outside Supabase auth");

    // Rollback drops the link_codes columns; the code row keeps working.
    await sql`INSERT INTO link_codes (code, discord_user_id, expires_at, discord_username)
              VALUES ('AAAA-AAAA', 'u-x', NOW() + INTERVAL '5 minutes', 'Alice')`;
    await runMigrations(sql as any, 37);
    const gone = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'link_codes' AND column_name IN ('discord_username', 'discord_avatar_url')`;
    assert.equal(gone.length, 0, "rollback should drop the snapshot columns");
    const row = await sql`SELECT code FROM link_codes WHERE code = 'AAAA-AAAA'`;
    assert.equal(row.length, 1, "the code row itself survives the column drop");
  } finally { await sql.end(); }
});

test("migration v41 makes consent_events discord_user_id nullable + locks RLS, guarded rollback", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const [col] = await sql<Array<{ is_nullable: string }>>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'consent_events' AND column_name = 'discord_user_id'`;
    assert.equal(col.is_nullable, "YES", "web-signup rows have no Discord id yet");

    const [rls] = await sql<Array<{ relrowsecurity: boolean }>>`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'consent_events'`;
    assert.equal(rls.relrowsecurity, true, "table must be RLS-locked off PostgREST");

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE indexname = 'consent_events_account_doc'`;
    assert.equal(idx.length, 1, "account/doc/version index exists");

    // The web RPCs are auth-schema-gated — plain Postgres gets none of them.
    const fns = await sql`SELECT proname FROM pg_proc WHERE proname IN ('my_consent', 'record_consent')`;
    assert.equal(fns.length, 0, "RPCs shouldn't exist outside Supabase auth");

    // A web-signup row (NULL uid) must block the rollback — data decision, not
    // silent loss. Removing it lets v40 restore NOT NULL.
    await sql`INSERT INTO consent_events (discord_user_id, account_id, document, version, source)
              VALUES (NULL, 'acc-web', 'terms', 1, 'web_signup')`;
    await assert.rejects(runMigrations(sql as any, 40), "rollback must refuse while web rows exist");
    await sql`DELETE FROM consent_events WHERE account_id = 'acc-web'`;
    await runMigrations(sql as any, 40);
    const [col2] = await sql<Array<{ is_nullable: string }>>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'consent_events' AND column_name = 'discord_user_id'`;
    assert.equal(col2.is_nullable, "NO", "rollback restores NOT NULL once clean");
  } finally { await sql.end(); }
});

test("migration v42 adds provenance columns; RPC/storage skipped outside Supabase; guarded rollback", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const cols = await sql<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE column_name IN ('persona_source', 'import_meta')
        AND table_name IN ('companions', 'companion_listings')
      ORDER BY table_name, column_name`;
    assert.equal(cols.length, 4, "both tables get both provenance columns");

    // The web RPC + storage bucket are auth/storage-schema-gated — plain
    // Postgres gets neither.
    const fns = await sql`SELECT proname FROM pg_proc WHERE proname = 'import_companion_card'`;
    assert.equal(fns.length, 0, "RPC shouldn't exist outside Supabase auth");

    // Rollback refuses while provenance rows exist — data decision, not loss.
    const c = await sql`INSERT INTO companions
      (owner_user_id, name, voice_persona, core_traits, owner_dynamic, backstory,
       onboarding_state, onboarding_turns, kind, persona_source, import_meta, created_at, updated_at)
      VALUES ('u-x', 'Imp', 'p', '{}', 'd', 'b', 'active', 0, 'adopted', 'card_import',
              '{"sha256":"x"}'::jsonb, NOW(), NOW()) RETURNING id`;
    assert.ok(c.length === 1);
    await assert.rejects(runMigrations(sql as any, 41), "rollback must refuse while imports exist");
    await sql`DELETE FROM companions WHERE owner_user_id = 'u-x'`;
    await runMigrations(sql as any, 41);
    const gone = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'companions' AND column_name IN ('persona_source', 'import_meta')`;
    assert.equal(gone.length, 0, "clean rollback drops both columns");
  } finally { await sql.end(); }
});

test("migration v43 adds published_at and backfills live listings only", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any, 42);

    // One already-live listing + one private import, both predating v43.
    await sql`INSERT INTO companion_listings
      (creator_user_id, name, tagline, voice_persona, core_traits, owner_dynamic,
       backstory, greeting, version, status, persona_source, import_meta, created_at, updated_at)
      VALUES
      ('u-live', 'Live', 't', 'p', '{}', 'd', 'b', 'hi', 1, 'active', 'authored', NULL, NOW(), NOW()),
      ('u-priv', 'Priv', 't', 'p', '{}', 'd', 'b', 'hi', 1, 'unlisted', 'card_import',
       '{"sha256":"y"}'::jsonb, NOW(), NOW())`;

    await runMigrations(sql as any, 43);
    const rows = await sql<Array<{ name: string; published_at: Date | null }>>`
      SELECT name, published_at FROM companion_listings ORDER BY name`;
    const priv = rows.find(r => r.name === "Priv")!;
    const live = rows.find(r => r.name === "Live")!;
    assert.equal(priv.published_at, null, "unlisted import has never been published");
    assert.ok(live.published_at, "live listing backfills published_at");

    await runMigrations(sql as any, 42);
    const gone = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'companion_listings' AND column_name = 'published_at'`;
    assert.equal(gone.length, 0, "rollback drops published_at");
  } finally { await sql.end(); }
});

test("migration v44 adds chat_imports + journal provenance; RPCs skipped outside Supabase; guarded rollback", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const t = await sql`SELECT to_regclass('public.chat_imports') AS r`;
    assert.ok(t[0].r, "chat_imports exists");
    const cols = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'companion_journal' AND column_name IN ('source', 'import_id')`;
    assert.equal(cols.length, 2, "journal gets source + import_id");

    // Auth-gated RPCs — plain Postgres gets none of them.
    const fns = await sql`SELECT proname FROM pg_proc
      WHERE proname IN ('my_companions', 'my_chat_imports', 'import_chat_history')`;
    assert.equal(fns.length, 0, "RPCs shouldn't exist outside Supabase auth");

    // Rollback refuses while import rows exist.
    const c = await sql`INSERT INTO companions
      (owner_user_id, name, voice_persona, core_traits, owner_dynamic, backstory,
       onboarding_state, onboarding_turns, kind, created_at, updated_at)
      VALUES ('u-ci', 'Nyx', 'p', '{}', 'd', 'b', 'active', 0, 'awakened', NOW(), NOW())
      RETURNING id`;
    await sql`INSERT INTO chat_imports (owner_user_id, companion_id, sha256)
      VALUES ('u-ci', ${c[0].id}, 'x')`;
    await assert.rejects(runMigrations(sql as any, 43), "rollback must refuse while imports exist");

    await sql`DELETE FROM chat_imports`;
    await runMigrations(sql as any, 43);
    const gone = await sql`SELECT to_regclass('public.chat_imports') AS r`;
    assert.equal(gone[0].r, null, "clean rollback drops chat_imports");
    const jcols = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'companion_journal' AND column_name IN ('source', 'import_id')`;
    assert.equal(jcols.length, 0, "clean rollback drops journal provenance columns");
  } finally { await sql.end(); }
});

test("migration v45 adds delete_chat_import RPC (auth-gated, skipped outside Supabase)", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const fns = await sql`SELECT proname FROM pg_proc WHERE proname = 'delete_chat_import'`;
    assert.equal(fns.length, 0, "RPC shouldn't exist outside Supabase auth");

    await runMigrations(sql as any, 44);
    // Down is a plain function drop — nothing to guard, just gone (or absent).
    const still = await sql`SELECT proname FROM pg_proc WHERE proname = 'delete_chat_import'`;
    assert.equal(still.length, 0);
  } finally { await sql.end(); }
});

test("migration v46 adds server_settings.quiet_channels, rolls back cleanly", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const cols = await sql<Array<{ column_default: string | null }>>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'server_settings' AND column_name = 'quiet_channels'`;
    assert.equal(cols.length, 1, "quiet_channels column missing");
    assert.match(cols[0].column_default ?? "", /\{\}/, "default should be the empty array");

    // Functional: a fresh guild row picks up the empty-list default.
    await sql`INSERT INTO server_settings (guild_id) VALUES ('g-v46')`;
    const [r] = await sql`SELECT quiet_channels FROM server_settings WHERE guild_id = 'g-v46'`;
    assert.deepEqual(r.quiet_channels, []);

    await runMigrations(sql as any, 45);
    const gone = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'server_settings' AND column_name = 'quiet_channels'`;
    assert.equal(gone.length, 0, "rollback should drop quiet_channels");
  } finally { await sql.end(); }
});

test("migration v47 adds app_installs + record_app_install, guarded rollback", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    // The RPC upserts install events (service-role only in prod — callable
    // directly here under the test's superuser).
    await sql`SELECT public.record_app_install('u1', 'authorized', '{"s":1}'::jsonb)`;
    const [r] = await sql`SELECT event, deauthorized_at FROM app_installs WHERE discord_user_id = 'u1'`;
    assert.equal(r.event, "authorized");
    assert.equal(r.deauthorized_at, null);

    await sql`SELECT public.record_app_install('u1', 'deauthorized', '{}'::jsonb)`;
    const [r2] = await sql`SELECT event, deauthorized_at FROM app_installs WHERE discord_user_id = 'u1'`;
    assert.equal(r2.event, "deauthorized");
    assert.ok(r2.deauthorized_at);

    // Guarded rollback: data present → refuse.
    await assert.rejects(() => runMigrations(sql as any, 46), /v47 rollback refused/);
    await sql`DELETE FROM app_installs`;
    await runMigrations(sql as any, 46);
    const gone = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'app_installs'`;
    assert.equal(gone.length, 0, "rollback should drop app_installs");
  } finally { await sql.end(); }
});

test("migration v48 adds support_tickets + one-open-per-user index, guarded rollback", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    await sql`INSERT INTO support_tickets (thread_id, guild_id, opener_id, subject, details)
              VALUES ('t1', 'g1', 'u1', 'billing', 'charged twice')`;
    // Second open ticket for the same opener hits the partial unique index.
    await assert.rejects(
      () => sql`INSERT INTO support_tickets (thread_id, guild_id, opener_id, subject, details)
                VALUES ('t2', 'g1', 'u1', 'again', 'double')`,
      /duplicate key|support_tickets_one_open_per_user/,
    );
    // Closing frees the slot.
    await sql`UPDATE support_tickets SET status = 'closed', closed_at = NOW() WHERE thread_id = 't1'`;
    await sql`INSERT INTO support_tickets (thread_id, guild_id, opener_id, subject, details)
              VALUES ('t3', 'g1', 'u1', 'new', 'follow-up')`;

    // Guarded rollback: data present → refuse; empty → drop.
    await assert.rejects(() => runMigrations(sql as any, 47), /v48 rollback refused/);
    await sql`DELETE FROM support_tickets`;
    await runMigrations(sql as any, 47);
    const gone = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'support_tickets'`;
    assert.equal(gone.length, 0, "rollback should drop support_tickets");
  } finally { await sql.end(); }
});

test("migration v54 adds companion_adoptions.chat_thread_id + partial index, rolls back", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const col = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'companion_adoptions' AND column_name = 'chat_thread_id'`;
    assert.equal(col.length, 1, "chat_thread_id should exist on companion_adoptions");

    // The partial index only covers stamped threads — NULL rows never index.
    const idx = await sql<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'companion_adoptions' AND indexname = 'adoptions_thread'`;
    assert.equal(idx.length, 1, "adoptions_thread partial index should exist");

    const [src] = await sql<Array<{ id: number }>>`
      INSERT INTO companions (owner_user_id) VALUES ('u-src') RETURNING id`;
    const [listing] = await sql<Array<{ id: number }>>`
      INSERT INTO companion_listings (creator_user_id, source_companion_id, name)
      VALUES ('u-creator', ${src.id}, 'Threaded') RETURNING id`;
    const [c1] = await sql<Array<{ id: number }>>`INSERT INTO companions (owner_user_id) VALUES ('u-c1') RETURNING id`;
    const [c2] = await sql<Array<{ id: number }>>`INSERT INTO companions (owner_user_id) VALUES ('u-c2') RETURNING id`;
    await sql`INSERT INTO companion_adoptions (user_id, listing_id, companion_id, chat_thread_id)
              VALUES ('u1', ${listing.id}, ${c1.id}, 't-thread-1')`;
    await sql`INSERT INTO companion_adoptions (user_id, listing_id, companion_id)
              VALUES ('u2', ${listing.id}, ${c2.id})`;

    await runMigrations(sql as any, 53);
    const gone = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'companion_adoptions' AND column_name = 'chat_thread_id'`;
    assert.equal(gone.length, 0, "rollback should drop chat_thread_id");
  } finally { await sql.end(); }
});

test("migration v68 adds companion_listings.openings with an array CHECK; guarded rollback", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const col = await sql<Array<{ column_default: string }>>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'companion_listings' AND column_name = 'openings'`;
    assert.equal(col.length, 1, "openings column exists");
    assert.equal(col[0].column_default, "'[]'::jsonb", "defaults to an empty array");

    // The CHECK constraint — an object-shaped blob is rejected, arrays pass.
    await assert.rejects(
      sql`INSERT INTO companion_listings (creator_user_id, name, openings) VALUES ('u-v68', 'BadShape', '{"text":"x"}'::jsonb)`,
      "non-array openings must fail the CHECK",
    );
    const [row] = await sql<Array<{ id: number; openings: unknown }>>`
      INSERT INTO companion_listings (creator_user_id, name, openings)
      VALUES ('u-v68', 'Scenic', '[{"text":"hi"}]'::jsonb) RETURNING id, openings`;
    assert.ok(Array.isArray(row.openings));

    // Rollback refuses while any row holds real openings — scenes are data.
    await assert.rejects(runMigrations(sql as any, 67), "rollback must refuse while openings exist");
    await sql`DELETE FROM companion_listings WHERE id = ${row.id}`;
    await runMigrations(sql as any, 67);
    const gone = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'companion_listings' AND column_name = 'openings'`;
    assert.equal(gone.length, 0, "clean rollback drops the column");
  } finally { await sql.end(); }
});

test("migration v64 creates the listing_rating_stats view — one row per listing, rolls back", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);

    const [l1] = await sql<[{ id: number }]>`INSERT INTO companion_listings (creator_user_id, name) VALUES ('u-v64', 'Rated') RETURNING id`;
    const [l2] = await sql<[{ id: number }]>`INSERT INTO companion_listings (creator_user_id, name) VALUES ('u-v64', 'Unrated') RETURNING id`;
    await sql`INSERT INTO listing_ratings (listing_id, rater_user_id, stars) VALUES
              (${l1.id}, 'u-r1', 5), (${l1.id}, 'u-r2', 3), (${l1.id}, 'u-r3', 4)`;

    // The view groups server-side — unrated listings produce no row at all.
    const stats = await sql<Array<{ listing_id: number; avg: number; rating_count: number }>>`
      SELECT listing_id, avg, rating_count FROM listing_rating_stats`;
    assert.equal(stats.length, 1);
    assert.equal(Number(stats[0].listing_id), Number(l1.id));
    assert.equal(stats[0].avg, 4);
    assert.equal(stats[0].rating_count, 3);
    const unrated = await sql`SELECT * FROM listing_rating_stats WHERE listing_id = ${l2.id}`;
    assert.equal(unrated.length, 0);

    await runMigrations(sql as any, 63);
    const gone = await sql<[{ t: string | null }]>`
      SELECT to_regclass('public.listing_rating_stats') AS t`;
    assert.equal(gone[0].t, null, "rollback should drop the view");
  } finally { await sql.end(); }
});
