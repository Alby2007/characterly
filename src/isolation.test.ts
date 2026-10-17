import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import type { ChatInputCommandInteraction } from "discord.js";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { handleMemoryCommand } from "./commands.js";
import { ProfileStore } from "./profiles.js";
import { buildPairContext } from "./lookup-tools.js";
import { encryptSecret } from "./secrets.js";
import { config } from "./config.js";
import type { Brain } from "./brain.js";

config.keyEncryptionSecret = "test-master-passphrase"; // seeding needs encryptSecret

// ── Cross-guild isolation ────────────────────────────────────────────────────
// The publish-readiness proof: every read surface must be scoped so guild A
// can never see guild B's rows — including B's IDs passed into A's commands
// (memory IDs are a global sequence, so a bare-ID lookup is the real test).

const A = "g-alpha", B = "g-beta";

/** Seed a guild end-to-end: members, messages, memories+evidence, profiles,
 * attributes, relationships, events, a guild key, settings, usage, a job. */
async function seedGuild(sql: ReturnType<typeof postgres>, g: string, tag: string) {
  const mid = `${g}-m1`;
  await sql`INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at) VALUES (${mid}, ${g}, 'c1', 'u1', ${tag + 'Alice'}, ${tag + ' secret lore'}, now())`;
  await sql`INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, opted_in, message_count) VALUES (${g}, 'u1', ${`{${tag}Alice}`}, now(), now(), 1, 5)`;
  await sql`INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, opted_in, message_count) VALUES (${g}, 'u2', ${`{${tag}Bob}`}, now(), now(), 1, 3)`;
  await sql`INSERT INTO server_settings (guild_id, memory_enabled, reply_enabled) VALUES (${g}, 1, 1)`;
  await sql`INSERT INTO guild_keys (guild_id, key_enc, key_hint, base_url) VALUES (${g}, ${encryptSecret(`${tag}-sk-live`)}, ${'…' + tag.slice(-4)}, NULL)`;
  const [mem] = await sql`INSERT INTO memories (guild_id, subject_id, kind, content, confidence, importance, status) VALUES (${g}, 'u1', 'person_fact', ${tag + ' fact'}, 0.9, 0.5, 'active') RETURNING id`;
  const [ev] = await sql`INSERT INTO events (guild_id, channel_id, occurred_at, title, summary) VALUES (${g}, 'c1', now(), ${tag + ' event'}, ${tag + ' summary'}) RETURNING id`;
  const [evid] = await sql`INSERT INTO memory_evidence (memory_id, message_id, author_id, quote, reason, explicitness, observed_at) VALUES (${mem.id}, ${mid}, 'u1', ${tag + ' quote'}, 'r', 0.9, now()) RETURNING id`;
  await sql`INSERT INTO event_messages (event_id, message_id) VALUES (${ev.id}, ${mid})`;
  await sql`INSERT INTO event_memories (event_id, memory_id) VALUES (${ev.id}, ${mem.id})`;
  await sql`INSERT INTO event_participants (event_id, user_id, user_name) VALUES (${ev.id}, 'u1', ${tag + 'Alice'})`;
  await sql`INSERT INTO profiles (guild_id, subject_id, display_name, summary) VALUES (${g}, 'u1', ${tag + 'Alice'}, ${tag + ' bio'})`;
  await sql`INSERT INTO profile_attributes (guild_id, subject_id, field, value, value_norm, confidence, status) VALUES (${g}, 'u1', ${tag + 'field'}, ${tag + 'val'}, ${tag + 'val'}, 0.9, 'active')`;
  await sql`INSERT INTO relationship_observations (guild_id, subject_id, other_id, message_id, nature) VALUES (${g}, 'u1', 'u2', ${mid}, ${tag + ' rel'})`;
  await sql`INSERT INTO relationships (guild_id, subject_id, other_id, summary) VALUES (${g}, 'u1', 'u2', ${tag + ' edge'})`;
  await sql`INSERT INTO guild_usage (guild_id, day, llm_calls) VALUES (${g}, (now() AT TIME ZONE 'UTC')::date, 7)`;
  await sql`INSERT INTO jobs (guild_id, type, payload) VALUES (${g}, 'extract', '{}')`;
  return { memoryId: Number(mem.id), messageId: mid };
}

function stubCommand(opts: { commandName: string; guildId: string; userId?: string; admin?: boolean; options?: Record<string, unknown> }) {
  const replies: any[] = [];
  const interaction = {
    guildId: opts.guildId,
    channelId: "c1",
    commandName: opts.commandName,
    user: { id: opts.userId ?? "u1", username: "User" },
    memberPermissions: { has: () => !!opts.admin },
    options: {
      getBoolean: (n: string) => opts.options?.[n] ?? null,
      getInteger: (n: string) => opts.options?.[n] ?? null,
      getString: (n: string) => opts.options?.[n] ?? null,
      getUser: (n: string) => opts.options?.[n] ?? null,
      getChannel: (n: string) => opts.options?.[n] ?? null,
    },
    reply: async (r: any) => { replies.push(r); return r; },
    editReply: async (r: any) => { replies.push({ content: r }); return r; },
    deferReply: async () => {},
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies };
}

const brainFor = async () => ({}) as Brain;

test("store read paths return only the querying guild's rows", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const a = await seedGuild(sql, A, "ALPHA");
    const b = await seedGuild(sql, B, "BETA");

    // Memories: list/search/relevant all scoped.
    const list = await store.listMemories(A, "u1", {});
    assert.ok(list.memories.length > 0);
    assert.ok(list.memories.every(m => m.content.includes("ALPHA")), "listMemories leaked B rows");
    const search = await store.searchMemories(A, "BETA", 10);
    assert.equal(search.length, 0, "searchMemories surfaced B content into A");
    const relevant = await store.relevantMemories(A, "u1");
    assert.ok(relevant.every(m => m.content.includes("ALPHA")));

    // Bare-ID lookups are the dangerous path — B's global-sequence ID must
    // resolve to nothing (or to A's row, never B's) from guild A.
    const cross = await store.getMemory(A, b.memoryId);
    assert.ok(!cross || !cross.content.includes("BETA"), "getMemory crossed guilds on a bare ID");
    const evid = await store.evidence(A, b.memoryId);
    assert.equal(evid.length, 0, "evidence() returned B rows for a B memory ID queried as A");

    // Profiles / attributes / relationships / pair context.
    const ps = new ProfileStore(sql as any);
    const profile = await ps.getProfile(A, "u1");
    assert.ok(profile?.summary?.includes("ALPHA"));
    const attrs = await store.attributesForSubjects(A, ["u1", "u2"]);
    assert.ok([...attrs.values()].flat().every(x => x.value.includes("ALPHA") || x.field.includes("ALPHA")));
    const rels = await store.relationshipsFor(A, "u1");
    assert.ok(rels.every(r => !JSON.stringify(r).includes("BETA")));
    const pair = await buildPairContext(store, eventStore, A, "u1", "u2");
    assert.ok(!pair || !JSON.stringify(pair).includes("BETA"));

    // Export — the most complete read surface.
    const dump = await store.exportSubject(A, "u1");
    assert.ok(!JSON.stringify(dump).includes("BETA"), "exportSubject leaked B data");

    // Keys: A must never resolve B's row.
    const keyA = await store.getGuildKey(A);
    assert.ok(keyA, "A has a key");
    const keyB = await store.getGuildKey(B);
    assert.notDeepEqual(keyA!.keyEnc, keyB!.keyEnc, "guild keys must be distinct rows");

    // Usage/queue depth scoped.
    assert.equal(await store.usageToday(A), 7);
    assert.equal((await store.queueStats(A)).pending, 1);
    assert.equal((await store.queueStats(B)).pending, 1);
  } finally { await sql.end(); }
});

test("command surfaces refuse or filter B's data when invoked from A", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const a = await seedGuild(sql, A, "ALPHA");
    const b = await seedGuild(sql, B, "BETA");
    const ps = new ProfileStore(sql as any);

    // /memory memory_id with B's ID — the global-sequence trap.
    const memB = stubCommand({ commandName: "memory", guildId: A, userId: "u1", admin: true, options: { memory_id: b.memoryId } });
    await handleMemoryCommand(memB.interaction, store, brainFor, eventStore, ps);
    assert.ok(!JSON.stringify(memB.replies).includes("BETA"), "/memory memory_id crossed guilds");

    // /memory list — only A rows.
    const memList = stubCommand({ commandName: "memory", guildId: A, userId: "u1" });
    await handleMemoryCommand(memList.interaction, store, brainFor, eventStore, ps);
    assert.ok(!JSON.stringify(memList.replies).includes("BETA"));

    // /memory stats — counts must be A-only.
    const stats = stubCommand({ commandName: "memory", guildId: A, userId: "u1", admin: true, options: { stats: true } });
    await handleMemoryCommand(stats.interaction, store, brainFor, eventStore, ps);
    assert.ok(!JSON.stringify(stats.replies).includes("BETA"));

    // /profile + /dossier as A's u1 — sees only A data.
    for (const name of ["profile", "dossier"]) {
      const cmd = stubCommand({ commandName: name, guildId: A, userId: "u1" });
      await handleMemoryCommand(cmd.interaction, store, brainFor, eventStore, ps);
      assert.ok(!JSON.stringify(cmd.replies).includes("BETA"), `/${name} leaked B data`);
    }

    // /memory-export — full dump must be A-only.
    const exp = stubCommand({ commandName: "memory-export", guildId: A, userId: "u1" });
    await handleMemoryCommand(exp.interaction, store, brainFor, eventStore, ps);
    assert.ok(!JSON.stringify(exp.replies).includes("BETA"), "/memory-export leaked B data");

    // /memory-triage — admin list of recent memories, A-only.
    const triage = stubCommand({ commandName: "memory-triage", guildId: A, userId: "u1", admin: true });
    await handleMemoryCommand(triage.interaction, store, brainFor, eventStore, ps);
    assert.ok(!JSON.stringify(triage.replies).includes("BETA"), "/memory-triage leaked B data");
    assert.ok(a.memoryId > 0 && b.memoryId > a.memoryId); // seeded — ids are a global sequence
  } finally { await sql.end(); }
});

// recentMemories has two consumers: admin triage (must see everything) and
// the server→DM digest (must respect consent). The gated variant applies the
// same subject predicate the recall paths use — server facts + opted-in,
// non-opted-out members — so opted-out or stray non-member rows can't gossip
// into a private DM.
test("recentMemories consentedOnly gates the DM digest to consented subjects", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const g = "g-consent";
    await sql`INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, opted_in, message_count) VALUES (${g}, 'u-yes', '{Yes}', now(), now(), 1, 1)`;
    await sql`INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, opted_in, message_count) VALUES (${g}, 'u-never', '{Never}', now(), now(), 0, 1)`;
    await sql`INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, opted_in, opted_out, message_count) VALUES (${g}, 'u-left', '{Left}', now(), now(), 1, 1, 1)`;
    for (const [subj, content] of [
      ["u-yes", "consented fact"],
      ["u-left", "opted-out fact"],
      ["u-never", "never-consented fact"],
      ["server", "server lore bit"],
      ["u-gone", "stale row — member gone"],
    ] as const) {
      await sql`INSERT INTO memories (guild_id, subject_id, kind, content, confidence, importance, status)
        VALUES (${g}, ${subj}, 'person_fact', ${content}, 0.9, 0.5, 'active')`;
    }

    const all = await store.recentMemories(g, 15);
    assert.equal(all.length, 5, "admin triage still sees every row");
    const gated = await store.recentMemories(g, 15, { consentedOnly: true });
    const contents = gated.map(m => m.content);
    assert.ok(contents.includes("consented fact"));
    assert.ok(contents.includes("server lore bit"));
    assert.ok(!contents.includes("opted-out fact"), "opted-out member leaked into the digest");
    assert.ok(!contents.includes("never-consented fact"), "never-consented member leaked into the digest");
    assert.ok(!contents.includes("stale row — member gone"), "a departed/non-member subject leaked into the digest");
  } finally { await sql.end(); }
});

// Abandoned-onboarding retention regression: recordMessage archives DMs under
// dm:<uid> from the FIRST onboarding turn — before the companion activates —
// but the old listActiveDmScopes only swept 'active' companions, retaining
// those rows (and any evidence verbatim) forever. listDmScopes must cover
// every dm: scope that holds data.
test("listDmScopes covers dm: scopes with data — not just awakened companions", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Companion stuck mid-awakening — onboarding_state != 'active'.
    await sql`INSERT INTO companions (owner_user_id, name, voice_persona, core_traits, owner_dynamic, backstory, onboarding_state, onboarding_turns, kind, created_at, updated_at)
      VALUES ('u-abandon', 'Ghost', 'p', '{}', 'd', 'b', 'onboarding', 3, 'awakened', now(), now())`;
    // Orphaned DM archive — messages exist but no companion row at all.
    await sql`INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at)
      VALUES ('dm-m1', 'dm:u-orphan', 'dm-c1', 'u-orphan', 'O', 'hi', now())`;
    const scopes = await store.listDmScopes();
    assert.ok(scopes.includes("dm:u-abandon"), "mid-onboarding scope missing — its DMs would never be pruned");
    assert.ok(scopes.includes("dm:u-orphan"), "message-only orphan scope missing");
  } finally { await sql.end(); }
});

// DM edit/delete events carry no guild — the *ById variants key on the
// globally-unique message snowflake instead. Same contract as the
// guild-scoped calls: update rewrites content; delete drops the row and
// scrubs the verbatim columns on any evidence it produced.
test("updateMessageContentById + deleteMessageById act on dm: rows by snowflake", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await sql`INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at)
      VALUES ('dm-del', 'dm:u-x', 'c', 'u-x', 'X', 'secret text', now())`;
    const [mem] = await sql`INSERT INTO memories (guild_id, subject_id, kind, content, confidence, importance, status)
      VALUES ('dm:u-x', 'u-x', 'person_fact', 'derived', 0.9, 0.5, 'active') RETURNING id`;
    await sql`INSERT INTO memory_evidence (memory_id, message_id, author_id, quote, message_content_snapshot, reason, explicitness, observed_at)
      VALUES (${mem.id}, 'dm-del', 'u-x', 'secret text', 'secret text', 'r', 0.9, now())`;

    await store.updateMessageContentById("dm-del", "edited");
    const [row] = await sql`SELECT content FROM messages WHERE id = 'dm-del'`;
    assert.equal(row.content, "edited");

    await store.deleteMessageById("dm-del");
    const [gone] = await sql`SELECT count(*)::int AS n FROM messages WHERE id = 'dm-del'`;
    assert.equal(gone.n, 0);
    const [ev] = await sql`SELECT quote, message_content_snapshot AS snap FROM memory_evidence WHERE message_id = 'dm-del'`;
    assert.equal(ev.quote, "", "verbatim quote scrubbed on delete");
    assert.equal(ev.snap, "", "content snapshot scrubbed on delete");
  } finally { await sql.end(); }
});
