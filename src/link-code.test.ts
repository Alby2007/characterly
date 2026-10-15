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
