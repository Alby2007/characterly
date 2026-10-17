import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { greetPendingInstalls, buildInstallGreetPayload } from "./install-greet.js";
import { makeTestSql, makeStore } from "./test-helpers.js";
import type { AppInstall } from "./types.js";

// The sweep's store surface is narrow (Pick<>) — fake it without a DB.

function install(userId: string, over: Partial<AppInstall> = {}): AppInstall {
  return {
    discordUserId: userId, event: "authorized", meta: null,
    greetedAt: null, deauthorizedAt: null, attempts: 0, lastError: null,
    createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", ...over,
  };
}
function fakeStore(pending: AppInstall[]) {
  const greeted = new Set<string>();
  const failures: Array<{ id: string; error: string }> = [];
  return {
    greeted, failures,
    store: {
      pendingInstallGreets: async (limit = 10) => pending.slice(0, limit),
      markInstallGreeted: async (id: string) => { greeted.add(id); },
      markInstallGreetFailed: async (id: string, error: string) => { failures.push({ id, error }); },
    },
  };
}

test("greetPendingInstalls sends the welcome DM and marks greeted", async () => {
  const { store, greeted, failures } = fakeStore([install("u1"), install("u2")]);
  const sent: string[] = [];
  const deps = {
    fetchUser: async (id: string) => ({ send: async () => { sent.push(id); return {}; } }),
    hasCompanion: async () => false,
    siteUrl: "https://characterly.example",
  };
  const r = await greetPendingInstalls(store as any, deps);
  assert.deepEqual(r, { greeted: 2, skipped: 0, failed: 0 });
  assert.deepEqual(sent, ["u1", "u2"]);
  assert.deepEqual([...greeted], ["u1", "u2"]);
  assert.equal(failures.length, 0);
});

test("already-companioned installs are marked greeted silently", async () => {
  const { store, greeted } = fakeStore([install("u1")]);
  const sent: string[] = [];
  const r = await greetPendingInstalls(store as any, {
    fetchUser: async (id: string) => ({ send: async () => { sent.push(id); return {}; } }),
    hasCompanion: async () => true,
    siteUrl: "https://x",
  });
  assert.deepEqual(r, { greeted: 0, skipped: 1, failed: 0 });
  assert.equal(sent.length, 0);
  assert.ok(greeted.has("u1"));
});

test("send failure marks failed, keeps going, never marks greeted", async () => {
  const { store, greeted, failures } = fakeStore([install("bad"), install("good")]);
  const deps = {
    fetchUser: async (id: string) => ({
      send: async () => { if (id === "bad") throw new Error("Cannot send messages to this user"); return {}; },
    }),
    hasCompanion: async () => false,
    siteUrl: "https://x",
  };
  const r = await greetPendingInstalls(store as any, deps);
  assert.deepEqual(r, { greeted: 1, skipped: 0, failed: 1 });
  assert.ok(!greeted.has("bad"));
  assert.ok(greeted.has("good"));
  assert.equal(failures[0].id, "bad");
  assert.match(failures[0].error, /Cannot send/);
});

test("welcome payload carries the onboard:start button + site link", async () => {
  const p = buildInstallGreetPayload("https://characterly.example");
  const row = p.components[0] as any;
  const ids = row.components.map((c: any) => c.data.custom_id ?? c.data.url);
  assert.ok(ids.includes("onboard:start"));
  assert.ok(ids.includes("https://characterly.example"));
});

test("pendingInstallGreets filters to authorized, ungreeted, under-attempts rows", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const raw = sql as any;
    // authorized+ungreeted → pending; greeted/deauthorized/exhausted → skipped.
    await raw`SELECT public.record_app_install('fresh', 'authorized', '{}'::jsonb)`;
    await raw`SELECT public.record_app_install('greeted', 'authorized', '{}'::jsonb)`;
    await raw`SELECT public.record_app_install('revoked', 'deauthorized', '{}'::jsonb)`;
    await raw`INSERT INTO app_installs (discord_user_id, event, attempts) VALUES ('tired', 'authorized', 5)`;
    await store.markInstallGreeted("greeted");

    const pending = await store.pendingInstallGreets();
    assert.deepEqual(pending.map(p => p.discordUserId), ["fresh"]);

    // Attempt-bump path: failure keeps the row pending until attempts cap.
    await store.markInstallGreetFailed("fresh", "Cannot send messages to this user");
    const after = await store.pendingInstallGreets();
    assert.equal(after[0].attempts, 1);
    assert.match(after[0].lastError ?? "", /Cannot send/);
  } finally { await sql.end(); }
});

// v49 ordering: Discord retries webhook deliveries — a redelivered AUTHORIZED
// landing after a real DEAUTHORIZED used to resurrect the row, and the greet
// sweep would then DM a revoked install. The event timestamp rides meta; only
// an event that isn't older than the recorded one may overwrite.
test("record_app_install ignores events older than the recorded one", async () => {
  const sql = makeTestSql();
  try {
    await makeStore(sql);
    const raw = sql as any;
    await raw`SELECT public.record_app_install('u1', 'authorized', '{"timestamp":"2024-01-01T00:00:00Z"}'::jsonb)`;
    await raw`SELECT public.record_app_install('u1', 'deauthorized', '{"timestamp":"2024-01-02T00:00:00Z"}'::jsonb)`;
    // Stale redelivery of the original authorized — must be ignored.
    await raw`SELECT public.record_app_install('u1', 'authorized', '{"timestamp":"2024-01-01T00:00:00Z"}'::jsonb)`;
    let [row] = await raw`SELECT event, deauthorized_at FROM app_installs WHERE discord_user_id = 'u1'`;
    assert.equal(row.event, "deauthorized", "stale replay must not clear the revocation");
    assert.ok(row.deauthorized_at, "deauthorized_at survives the stale replay");

    // A genuinely newer authorized event still applies.
    await raw`SELECT public.record_app_install('u1', 'authorized', '{"timestamp":"2024-01-03T00:00:00Z"}'::jsonb)`;
    [row] = await raw`SELECT event, deauthorized_at FROM app_installs WHERE discord_user_id = 'u1'`;
    assert.equal(row.event, "authorized");
    assert.equal(row.deauthorized_at, null);
  } finally { await sql.end(); }
});
