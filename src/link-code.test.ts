import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeStore, makeTestSql } from "./test-helpers.js";

// link_codes backs the Discord-side /link flow: the bot mints a one-time code
// here; the web account claims it via the claim_link_code rpc (auth-schema
// gated, exercised live rather than against plain test Postgres).

test("createLinkCode returns an XXXX-XXXX code from the unambiguous alphabet", async () => {
  const sql = makeTestSql();
  const { store } = await makeStore(sql);
  const code = await store.createLinkCode("u-alice");
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  const rows = await sql`SELECT * FROM link_codes WHERE code = ${code}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].discord_user_id, "u-alice");
  assert.ok(rows[0].expires_at > new Date(), "code must not already be expired");
  assert.equal(rows[0].claimed_by, null);
  await sql.end();
});

test("re-issuing a code for the same Discord user replaces the old one", async () => {
  const sql = makeTestSql();
  const { store } = await makeStore(sql);
  const first = await store.createLinkCode("u-alice");
  const second = await store.createLinkCode("u-alice");
  assert.notEqual(first, second);
  const rows = await sql`SELECT code FROM link_codes WHERE discord_user_id = 'u-alice'`;
  assert.deepEqual(rows.map(r => r.code), [second]);
  await sql.end();
});

test("issuing a code sweeps expired rows for other users", async () => {
  const sql = makeTestSql();
  const { store } = await makeStore(sql);
  await sql`INSERT INTO link_codes (code, discord_user_id, expires_at) VALUES ('AAAA-BBBB', 'u-bob', NOW() - INTERVAL '1 minute')`;
  await sql`INSERT INTO link_codes (code, discord_user_id, expires_at) VALUES ('CCCC-DDDD', 'u-carol', NOW() + INTERVAL '5 minutes')`;
  await store.createLinkCode("u-alice");
  const codes = (await sql`SELECT code FROM link_codes ORDER BY code`).map(r => r.code);
  assert.ok(!codes.includes("AAAA-BBBB"), "expired code should be swept");
  assert.ok(codes.includes("CCCC-DDDD"), "unexpired code for another user is untouched");
  await sql.end();
});

test("different users get different codes", async () => {
  const sql = makeTestSql();
  const { store } = await makeStore(sql);
  const a = await store.createLinkCode("u-alice");
  const b = await store.createLinkCode("u-bob");
  assert.notEqual(a, b);
  assert.equal((await sql`SELECT count(*)::int AS n FROM link_codes`)[0].n, 2);
  await sql.end();
});

test("createLinkCode carries the Discord profile snapshot for the claim to copy", async () => {
  const sql = makeTestSql();
  const { store } = await makeStore(sql);
  const code = await store.createLinkCode("u-alice", 10, {
    username: "Alice W.",
    avatarUrl: "https://cdn.discordapp.com/avatars/u-alice/abc.png",
  });
  const rows = await sql`SELECT discord_username, discord_avatar_url FROM link_codes WHERE code = ${code}`;
  assert.equal(rows[0].discord_username, "Alice W.");
  assert.equal(rows[0].discord_avatar_url, "https://cdn.discordapp.com/avatars/u-alice/abc.png");
  // No profile passed → snapshot columns stay NULL (claim copies NULLs harmlessly).
  const bare = await store.createLinkCode("u-bob");
  const bareRow = await sql`SELECT discord_username FROM link_codes WHERE code = ${bare}`;
  assert.equal(bareRow[0].discord_username, null);
  await sql.end();
});

test("syncDiscordIdentity fills the snapshot; missing-scan only lists the gaps", async () => {
  const sql = makeTestSql();
  // web_profiles is auth-gated — recreate the minimal fixture columns v38 adds.
  await sql`
    CREATE TABLE IF NOT EXISTS web_profiles (
      id UUID PRIMARY KEY, discord_user_id TEXT UNIQUE,
      discord_username TEXT, discord_avatar_url TEXT,
      plan TEXT NOT NULL DEFAULT 'free', credit_balance INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  const { store } = await makeStore(sql);
  assert.equal(await store.initCreditsSupport(), true);
  try {
    await sql`INSERT INTO web_profiles (id, discord_user_id) VALUES (gen_random_uuid(), 'u-old'), (gen_random_uuid(), NULL)`;
    await sql`INSERT INTO web_profiles (id, discord_user_id, discord_username) VALUES (gen_random_uuid(), 'u-has', 'Already')`;
    assert.deepEqual((await store.linkedProfilesMissingDiscordIdentity()).sort(), ["u-old"]);

    await store.syncDiscordIdentity("u-old", "OldUser", "https://cdn.discordapp.com/avatars/u-old/x.png");
    assert.equal((await store.linkedProfilesMissingDiscordIdentity()).length, 0);
    const row = await sql`SELECT discord_username, discord_avatar_url FROM web_profiles WHERE discord_user_id = 'u-old'`;
    assert.equal(row[0].discord_username, "OldUser");
    assert.equal(row[0].discord_avatar_url, "https://cdn.discordapp.com/avatars/u-old/x.png");
    // An unlinked account row is never listed or touched.
    const none = await sql`SELECT discord_username FROM web_profiles WHERE discord_user_id IS NULL`;
    assert.equal(none[0].discord_username, null);
  } finally {
    await sql`DROP TABLE IF EXISTS web_profiles`;
    await sql.end();
  }
});
