import "dotenv/config";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { makeStore, makeTestSql } from "./test-helpers.js";
import type { MemoryStore } from "./database.js";
import { migrations } from "./migrations.js";
import { runWebTurnJob, type WebTurnDeps } from "./web-turn.js";
import { FatalJobError, type Job } from "./jobs.js";
import type { CompanionTurnOpts } from "./companion-turn.js";

// v73 web chat — the browser-first companion path. Tables are unconditional;
// RPCs/RLS sit behind the auth gate, so tests stand the schema + a tx-local
// auth.uid() stub up like the v71/v72 suites. Companion/listing tables come
// from the shared migrations (makeStore); web_profiles is a fixture.

const sql = makeTestSql();
after(() => sql.end());

async function webFixture() {
  await sql`
    CREATE TABLE IF NOT EXISTS web_profiles (
      id                  UUID PRIMARY KEY,
      display_name        TEXT,
      discord_user_id     TEXT UNIQUE,
      discord_username    TEXT,
      discord_avatar_url  TEXT,
      plan                TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','premium')),
      credit_balance      INT NOT NULL DEFAULT 0,
      purchased_balance   INT NOT NULL DEFAULT 0,
      last_daily_grant_on DATE,
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
  await sql`CREATE SCHEMA IF NOT EXISTS auth`;
  await sql`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $s$ SELECT nullif(current_setting('app.claim_uid', true), '')::uuid $s$`;
  const { store, eventStore } = await makeStore(sql);
  // Tables already exist from makeStore's full migration run — re-running v73
  // adds the auth-gated objects (CREATE OR REPLACE/IF NOT EXISTS throughout).
  await migrations.find(m => m.version === 73)!.up(sql as never);
  return { store, eventStore };
}

async function teardownWeb() {
  await sql`DROP POLICY IF EXISTS web_messages_select_own ON public.web_messages`;
  await sql`DROP POLICY IF EXISTS web_conversations_select_own ON public.web_conversations`;
  for (const sig of [
    "web_adopt_listing(bigint)", "web_my_adoptions()", "web_open_conversation(bigint)",
    "web_my_conversations()", "web_send_message(bigint, text, uuid)",
    "web_conversation_messages(bigint, bigint, int)", "web_archive_conversation(bigint, boolean)",
    "web_drop_adoption(bigint)", "web_report_listing(bigint, text, text)",
    "web_open_conv_for(uuid, bigint)", "web_clean_name(text, int)",
  ]) {
    await sql.unsafe(`DROP FUNCTION IF EXISTS public.${sig}`);
  }
  await sql`DROP TABLE IF EXISTS credit_ledger`;
  await sql`DROP SCHEMA IF EXISTS auth CASCADE`;
}

async function addProfile(discordUserId: string | null, plan = "free", balance = 100) {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO web_profiles (id, discord_user_id, plan, credit_balance, display_name)
    VALUES (gen_random_uuid(), ${discordUserId}, ${plan}, ${balance}, 'Web User')
    RETURNING id
  `;
  return rows[0].id;
}

const rpc = async <T>(uid: string | null, call: (tx: any) => Promise<Array<{ r: T }>>): Promise<T> => {
  const rows = (await sql.begin(async tx => {
    await tx`SELECT set_config('app.claim_uid', ${uid ?? ""}, true)`;
    return call(tx);
  })) as unknown as Array<{ r: T }>;
  return rows[0].r;
};

async function seedListing(store: MemoryStore, creatorId: string, name = "Nyx") {
  const companion = await store.activateCompanion(creatorId, "Owner", {
    name, voicePersona: "dry, sharp", coreTraits: ["witty"],
    ownerDynamic: "ride-or-die", backstory: "met in a chat", avatarUrl: null,
  });
  const res = await store.upsertListing(creatorId, companion.id, {
    name, tagline: "a very dry vampire", voicePersona: "dry, sharp",
    coreTraits: ["witty"], ownerDynamic: "protective friend",
    backstory: "old lore", greeting: "*looks up* …you again.", avatarUrl: null,
  });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("seedListing failed");
  return res.listing;
}

function fakeJob(payload: unknown): Job {
  return { id: 1, guild_id: "web:x", type: "web-turn", payload, attempts: 0 } as unknown as Job;
}

// ── Schema shape ────────────────────────────────────────────────────────────

test("v73 schema: transport tables, adoption columns, RLS armed", async () => {
  await webFixture();
  try {
    const cols = await sql<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('web_conversations', 'web_messages')
        AND column_name IN ('web_profile_id', 'conversation_id', 'role', 'status', 'client_msg_id', 'fail_reason')
      ORDER BY 1, 2`;
    assert.ok(cols.length >= 6, `expected core columns, got ${cols.length}`);

    const adoptionCols = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'companion_adoptions' AND column_name IN ('web_profile_id', 'origin')`;
    assert.equal(adoptionCols.length, 2);

    const rls = await sql<Array<{ relname: string; relrowsecurity: boolean }>>`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('web_conversations', 'web_messages')`;
    assert.deepEqual(rls.map(r => [r.relname, r.relrowsecurity].join(":")).sort(),
      ["web_conversations:true", "web_messages:true"]);
  } finally {
    await teardownWeb();
  }
});

// ── RPC paths ───────────────────────────────────────────────────────────────

test("v73 rpcs: unlinked adopt → conversation → send → job → messages → archive → drop", async () => {
  const { store } = await webFixture();
  try {
    const uid = await addProfile(null);
    const listing = await seedListing(store, "u-creator");

    const adopt = await rpc<any>(uid, tx => tx`SELECT public.web_adopt_listing(${listing.id}) AS r`);
    assert.equal(adopt.ok, true, JSON.stringify(adopt));
    assert.ok(adopt.conversation_id);
    assert.equal(adopt.name, "Nyx");

    // Companion cloned with the web: owner key; adoption stamped web-side.
    const comp = await sql`SELECT owner_user_id, kind FROM companions WHERE id = ${adopt.companion_id}`;
    assert.equal(comp[0].owner_user_id, `web:${uid}`);
    assert.equal(comp[0].kind, "adopted");
    const ad = await sql`SELECT user_id, web_profile_id::text wp, origin FROM companion_adoptions WHERE id = ${adopt.adoption_id}`;
    assert.equal(ad[0].user_id, `web:${uid}`);
    assert.equal(ad[0].wp, uid);
    assert.equal(ad[0].origin, "web");

    // Conversation scope is web:<uid> for unlinked accounts, greeting seeded.
    const conv = await sql`SELECT scope FROM web_conversations WHERE id = ${adopt.conversation_id}`;
    assert.equal(conv[0].scope, `web:${uid}`);
    const greet = await sql`SELECT role, content, status FROM web_messages WHERE conversation_id = ${adopt.conversation_id}`;
    assert.equal(greet[0].role, "companion");
    assert.ok(greet[0].content.includes("you again"));

    // Re-adopt is a free no-op on the same conversation.
    const again = await rpc<any>(uid, tx => tx`SELECT public.web_adopt_listing(${listing.id}) AS r`);
    assert.equal(again.reused, true);
    assert.equal(again.conversation_id, adopt.conversation_id);

    // web_open_conversation is idempotent on the live row.
    const opened = await rpc<any>(uid, tx => tx`SELECT public.web_open_conversation(${adopt.adoption_id}) AS r`);
    assert.equal(opened.conversation_id, adopt.conversation_id);
    assert.equal(opened.created, false);

    // Send: user row + pending placeholder + web-turn job in one shot.
    const cid = crypto.randomUUID();
    const sent = await rpc<any>(uid, tx => tx`SELECT public.web_send_message(${adopt.conversation_id}, ${"hi there"}, ${cid}::uuid) AS r`);
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.ok(sent.user_message_id && sent.companion_message_id);
    const job = await sql`SELECT guild_id, type, payload FROM jobs ORDER BY id DESC LIMIT 1`;
    assert.equal(job[0].type, "web-turn");
    assert.equal(job[0].guild_id, `web:${uid}`);
    assert.equal((job[0].payload as any).companionMessageId, sent.companion_message_id);

    // Idempotent resend returns the same pair — no second job.
    const resend = await rpc<any>(uid, tx => tx`SELECT public.web_send_message(${adopt.conversation_id}, ${"hi there"}, ${cid}::uuid) AS r`);
    assert.equal(resend.reused, true);
    assert.equal(resend.user_message_id, sent.user_message_id);
    assert.equal(resend.companion_message_id, sent.companion_message_id);
    const jobCount = await sql`SELECT count(*)::int c FROM jobs WHERE type = 'web-turn'`;
    assert.equal(jobCount[0].c, 1);

    // History read: greeting + user + pending placeholder.
    const msgs = await rpc<any[]>(uid, tx => tx`SELECT public.web_conversation_messages(${adopt.conversation_id}) AS r`);
    assert.equal(msgs.length, 3);
    assert.equal(msgs[1].role, "user");
    assert.equal(msgs[2].status, "pending");

    // Guard rails.
    assert.equal((await rpc<any>(uid, tx => tx`SELECT public.web_send_message(${adopt.conversation_id}, ${"   "}, ${crypto.randomUUID()}::uuid) AS r`)).reason, "empty");
    assert.equal((await rpc<any>(uid, tx => tx`SELECT public.web_send_message(${adopt.conversation_id}, ${"x".repeat(4001)}, ${crypto.randomUUID()}::uuid) AS r`)).reason, "too_long");
    const stranger = await addProfile(null);
    await assert.rejects(
      rpc<any>(stranger, tx => tx`SELECT public.web_send_message(${adopt.conversation_id}, ${"hax"}, ${crypto.randomUUID()}::uuid) AS r`),
      /not your conversation/);

    // Archive blocks sends; drop archives the open conversation too.
    await rpc<any>(uid, tx => tx`SELECT public.web_archive_conversation(${adopt.conversation_id}) AS r`);
    assert.equal((await rpc<any>(uid, tx => tx`SELECT public.web_send_message(${adopt.conversation_id}, ${"still here?"}, ${crypto.randomUUID()}::uuid) AS r`)).reason, "archived");
    await rpc<any>(uid, tx => tx`SELECT public.web_archive_conversation(${adopt.conversation_id}, false) AS r`);
    const dropped = await rpc<any>(uid, tx => tx`SELECT public.web_drop_adoption(${adopt.adoption_id}) AS r`);
    assert.equal(dropped.ok, true);
    const ad2 = await sql`SELECT dropped_at, cooldown_until FROM companion_adoptions WHERE id = ${adopt.adoption_id}`;
    assert.ok(ad2[0].dropped_at && ad2[0].cooldown_until);
    const conv2 = await sql`SELECT archived_at FROM web_conversations WHERE id = ${adopt.conversation_id}`;
    assert.ok(conv2[0].archived_at);
  } finally {
    await teardownWeb();
  }
});

test("v73 rpcs: linked account rides dm:<did> — same bond as Discord", async () => {
  const { store } = await webFixture();
  try {
    const uid = await addProfile("d-42");
    const listing = await seedListing(store, "u-creator2", "Moth");
    const adopt = await rpc<any>(uid, tx => tx`SELECT public.web_adopt_listing(${listing.id}) AS r`);
    assert.equal(adopt.ok, true);
    const comp = await sql`SELECT owner_user_id FROM companions WHERE id = ${adopt.companion_id}`;
    assert.equal(comp[0].owner_user_id, "d-42");
    const conv = await sql`SELECT scope FROM web_conversations WHERE id = ${adopt.conversation_id}`;
    assert.equal(conv[0].scope, "dm:d-42");

    // web_my_adoptions sees the Discord-keyed row; a web-adopted listing also
    // shows for a Discord adopter of the same account.
    const mine = await rpc<any[]>(uid, tx => tx`SELECT public.web_my_adoptions() AS r`);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].name, "Moth");
    assert.equal(mine[0].open_conversation_id, adopt.conversation_id);
  } finally {
    await teardownWeb();
  }
});

test("v73 rpcs: gates — own listing, delisted, banned send, report flags", async () => {
  const { store } = await webFixture();
  try {
    const uid = await addProfile(null);
    const ownUid = await addProfile(null);

    // own_listing: creator's owner key is 'web:<ownUid>'.
    const own = await seedListing(store, `web:${ownUid}`, "Mine");
    assert.equal((await rpc<any>(ownUid, tx => tx`SELECT public.web_adopt_listing(${own.id}) AS r`)).reason, "own_listing");

    // delisted: flip status → adopt refuses.
    await sql`UPDATE companion_listings SET status = 'delisted' WHERE id = ${own.id}`;
    assert.equal((await rpc<any>(uid, tx => tx`SELECT public.web_adopt_listing(${own.id}) AS r`)).reason, "delisted");
    await sql`UPDATE companion_listings SET status = 'active' WHERE id = ${own.id}`;

    // banned listing: adopt ok? (banned → delisted gate catches it first)
    const banned = await seedListing(store, "u-ban", "Baddie");
    await sql`UPDATE companion_listings SET status = 'banned' WHERE id = ${banned.id}`;
    assert.equal((await rpc<any>(uid, tx => tx`SELECT public.web_adopt_listing(${banned.id}) AS r`)).reason, "delisted");

    // Existing adoption on a banned listing can't send.
    const listing = await seedListing(store, "u-creator3", "Ash");
    const adopt = await rpc<any>(uid, tx => tx`SELECT public.web_adopt_listing(${listing.id}) AS r`);
    await sql`UPDATE companion_listings SET status = 'banned' WHERE id = ${listing.id}`;
    assert.equal((await rpc<any>(uid, tx => tx`SELECT public.web_send_message(${adopt.conversation_id}, ${"hello"}, ${crypto.randomUUID()}::uuid) AS r`)).reason, "banned");
    await sql`UPDATE companion_listings SET status = 'active' WHERE id = ${listing.id}`;

    // Reports: insert + count, dup deduped, auto-flag at 3.
    const reporters = [await addProfile(null), await addProfile(null), await addProfile(null)];
    assert.equal((await rpc<any>(reporters[0], tx => tx`SELECT public.web_report_listing(${listing.id}, ${"hate"}) AS r`)).ok, true);
    assert.equal((await rpc<any>(reporters[0], tx => tx`SELECT public.web_report_listing(${listing.id}, ${"hate"}) AS r`)).reason, "dup");
    await rpc<any>(reporters[1], tx => tx`SELECT public.web_report_listing(${listing.id}, ${"other"}, ${"seems off"} ) AS r`);
    const third = await rpc<any>(reporters[2], tx => tx`SELECT public.web_report_listing(${listing.id}, ${"bogus-category"}) AS r`);
    assert.equal(third.count, 3);
    assert.equal(third.flagged, true);
    const after = await sql`SELECT status, report_count FROM companion_listings WHERE id = ${listing.id}`;
    assert.equal(after[0].status, "flagged");
    assert.equal(after[0].report_count, 3);
  } finally {
    await teardownWeb();
  }
});

// ── runWebTurnJob ───────────────────────────────────────────────────────────

test("web-turn job: unlinked scope, status transitions, row writes", async () => {
  const { store } = await webFixture();
  try {
    const uid = await addProfile(null);
    const listing = await seedListing(store, "u-creator4", "Guest");
    const adopt = await rpc<any>(uid, tx => tx`SELECT public.web_adopt_listing(${listing.id}) AS r`);
    const sent = await rpc<any>(uid, tx => tx`SELECT public.web_send_message(${adopt.conversation_id}, ${"hello companion"}, ${crypto.randomUUID()}::uuid) AS r`);

    const seen: { opts?: CompanionTurnOpts } = {};
    const deps: WebTurnDeps = {
      sql: sql as never,
      store,
      runTurn: async opts => {
        seen.opts = opts;
        const s = await opts.sendPersona("hi back!");
        assert.ok(s, "sendPersona should land");
        await opts.sendSystem({ content: "system note" });
      },
    };
    const jobRow = await sql`SELECT * FROM jobs WHERE type = 'web-turn' ORDER BY id DESC LIMIT 1`;
    await runWebTurnJob(jobRow[0].guild_id, jobRow[0] as Job, deps);

    const o = seen.opts!;
    assert.ok(o, "runTurn called");
    assert.equal(o.scope, `web:${uid}`);
    assert.equal(o.userId, `web:${uid}`);
    assert.equal(o.channel.id, `webconv:${adopt.conversation_id}`);
    assert.equal(o.charge?.payerAccountId, uid);
    assert.equal(o.charge?.reason, "web_turn");
    assert.equal(o.event.authorId, `web:${uid}`);
    assert.equal(o.event.authorName, "Web User");
    assert.equal(o.event.content, "hello companion");
    assert.equal(o.event.channelId, `webconv:${adopt.conversation_id}`);

    const msgs = await sql`SELECT role, status, content FROM web_messages WHERE conversation_id = ${adopt.conversation_id} ORDER BY id`;
    assert.deepEqual(msgs.map(m => m.status), ["done", "done", "done", "done"]);
    assert.equal(msgs[1].content, "hello companion");
    assert.equal(msgs[2].content, "hi back!");
    const sys = await sql`SELECT content FROM web_messages WHERE conversation_id = ${adopt.conversation_id} AND role = 'system'`;
    assert.equal(sys[0].content, "system note");

    // Retry after a landed send is a no-op — runTurn must not re-fire.
    delete seen.opts;
    await runWebTurnJob(jobRow[0].guild_id, jobRow[0] as Job, deps);
    assert.equal(seen.opts, undefined);
  } finally {
    await teardownWeb();
  }
});

test("web-turn job: linked user resolves to dm:<did> bond", async () => {
  const { store } = await webFixture();
  try {
    const uid = await addProfile("d-77");
    const listing = await seedListing(store, "u-creator5", "Link");
    const adopt = await rpc<any>(uid, tx => tx`SELECT public.web_adopt_listing(${listing.id}) AS r`);
    const sent = await rpc<any>(uid, tx => tx`SELECT public.web_send_message(${adopt.conversation_id}, ${"hi"}, ${crypto.randomUUID()}::uuid) AS r`);

    const seen: { opts?: CompanionTurnOpts } = {};
    await runWebTurnJob("dm:d-77", fakeJob({ companionMessageId: sent.companion_message_id, userMessageId: sent.user_message_id }), {
      sql: sql as never, store,
      runTurn: async opts => { seen.opts = opts; await opts.sendPersona("ok"); },
    });
    assert.equal(seen.opts!.scope, "dm:d-77");
    assert.equal(seen.opts!.userId, "d-77");
    assert.equal(seen.opts!.charge?.payerAccountId, uid);
  } finally {
    await teardownWeb();
  }
});

test("web-turn job: failure vocabulary — archived, dropped, banned, malformed", async () => {
  const { store } = await webFixture();
  try {
    const uid = await addProfile(null);
    const listing = await seedListing(store, "u-creator6", "Old");
    const adopt = await rpc<any>(uid, tx => tx`SELECT public.web_adopt_listing(${listing.id}) AS r`);
    const sent = await rpc<any>(uid, tx => tx`SELECT public.web_send_message(${adopt.conversation_id}, ${"hi"}, ${crypto.randomUUID()}::uuid) AS r`);
    let called = false;
    const deps: WebTurnDeps = { sql: sql as never, store, runTurn: async () => { called = true; } };
    const status = async () => (await sql`SELECT status, fail_reason FROM web_messages WHERE id = ${sent.companion_message_id}`)[0];

    // Archived conversation → failed/archived, turn never runs.
    await sql`UPDATE web_conversations SET archived_at = now() WHERE id = ${adopt.conversation_id}`;
    await runWebTurnJob("web:x", fakeJob({ companionMessageId: sent.companion_message_id, userMessageId: sent.user_message_id }), deps);
    assert.deepEqual(await status(), { status: "failed", fail_reason: "archived" });
    assert.equal(called, false);

    // Dropped adoption → failed/no_companion.
    await sql`UPDATE web_conversations SET archived_at = NULL WHERE id = ${adopt.conversation_id}`;
    await sql`UPDATE web_messages SET status = 'pending', fail_reason = NULL WHERE id = ${sent.companion_message_id}`;
    await sql`UPDATE companion_adoptions SET dropped_at = now() WHERE id = ${adopt.adoption_id}`;
    await runWebTurnJob("web:x", fakeJob({ companionMessageId: sent.companion_message_id, userMessageId: sent.user_message_id }), deps);
    assert.deepEqual(await status(), { status: "failed", fail_reason: "no_companion" });

    // Banned listing → failed/banned.
    await sql`UPDATE companion_adoptions SET dropped_at = NULL WHERE id = ${adopt.adoption_id}`;
    await sql`UPDATE web_messages SET status = 'pending', fail_reason = NULL WHERE id = ${sent.companion_message_id}`;
    await sql`UPDATE companion_listings SET status = 'banned' WHERE id = ${listing.id}`;
    await runWebTurnJob("web:x", fakeJob({ companionMessageId: sent.companion_message_id, userMessageId: sent.user_message_id }), deps);
    assert.deepEqual(await status(), { status: "failed", fail_reason: "banned" });
    await sql`UPDATE companion_listings SET status = 'active' WHERE id = ${listing.id}`;

    // Malformed payloads dead-letter instead of spinning.
    await assert.rejects(
      runWebTurnJob("web:x", fakeJob({}), deps),
      (e: Error) => e instanceof FatalJobError);
    await assert.rejects(
      runWebTurnJob("web:x", fakeJob({ companionMessageId: 999999 }), deps),
      (e: Error) => e instanceof FatalJobError);
  } finally {
    await teardownWeb();
  }
});

// ── Credit parity ───────────────────────────────────────────────────────────

test("spendCreditsForAccount/refundCreditsForAccount: account-keyed twin of spendCredits", async () => {
  await webFixture();
  try {
    const { store } = await makeStore(sql);
    await store.initCreditsSupport({ freeDaily: 30, premiumDaily: 150 });
    // Unlinked account — no discord_user_id at all. Lazy grant lands on first spend.
    const uid = await addProfile(null, "free", 0);
    const spend = await store.spendCreditsForAccount(uid, 2, "web_turn");
    assert.equal(spend.ok, true);
    assert.equal(spend.balance, 28); // 30 grant − 2 spend
    const refund = await store.refundCreditsForAccount(uid, 2, "web_turn_refund", 0);
    assert.equal(refund.ok, true);
    assert.equal(refund.balance, 30);
    const missing = await store.spendCreditsForAccount("00000000-0000-0000-0000-000000000099", 2, "x");
    assert.equal(missing.ok, false);
  } finally {
    await teardownWeb();
  }
});
