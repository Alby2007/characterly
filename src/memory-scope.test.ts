import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { persistExtraction } from "./persist-extraction.js";
import type { ExtractionResult, MessageEvent } from "./types.js";

// Companion-scoped memory: story_fact rows (fiction) stay with the companion
// they happened with; real facts stay shared. Pins always recall. The
// server→DM digest honors share_facts_with_companion_owners.

function msg(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1", channelId: "c1", messageId: `m-${Math.random().toString(36).slice(2)}`,
    authorId: "u1", authorName: "Ada",
    content: "test message", createdAt: new Date(), mentionsBot: false,
    ...overrides,
  };
}

const CONSENT_ALL = () => true;

/** Minimal companions row — story_fact rows have a real FK to it. */
async function companionRow(sql: ReturnType<typeof makeTestSql>, owner = "u1"): Promise<number> {
  const rows = await sql<Array<{ id: number }>>`
    INSERT INTO companions (owner_user_id, name, voice_persona, core_traits, owner_dynamic, backstory, onboarding_state)
    VALUES (${owner}, 'Nyx', 'wry', '{}', 'partner', '', 'active') RETURNING id`;
  return Number(rows[0].id);
}

test("story facts are companion-scoped; real facts stay shared", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const cid = await companionRow(sql);
    await store.setMemberOptIn("g1", "u1", true);
    const extraction: ExtractionResult = {
      memories: [
        { subjectId: "unknown", subjectName: "Ada", kind: "story_fact", content: "Ada duelled the harbor master", reason: "t", evidenceType: "in_fiction", effect: "support" },
        { subjectId: "unknown", subjectName: "Ada", kind: "person_fact", content: "Ada likes tea", reason: "t", evidenceType: "explicit_fact", effect: "support" },
      ],
      relationships: [],
    };
    await persistExtraction(extraction, msg(), { store, aliases: new Map([["ada", "u1"]]), isConsented: CONSENT_ALL, companionId: cid });

    // The story beat needs active status at insert — fiction isn't verified.
    const rows = await sql<Array<{ kind: string; status: string; companion_id: number | null }>>`
      SELECT kind, status, companion_id FROM memories WHERE guild_id = 'g1' ORDER BY id`;
    const story = rows.find(r => r.kind === "story_fact");
    const real = rows.find(r => r.kind === "person_fact");
    assert.equal(Number(story?.companion_id), cid);
    assert.equal(story?.status, "active");
    assert.equal(real?.companion_id, null);

    // This companion sees both; a different companion (or none) sees only the real fact.
    const forSeven = await store.relevantMemories("g1", "u1", 10, cid);
    const forEight = await store.relevantMemories("g1", "u1", 10, cid + 1);
    const forNone = await store.relevantMemories("g1", "u1", 10);
    assert.ok(forSeven.some(m => m.content === "Ada duelled the harbor master"));
    assert.ok(forSeven.some(m => m.content === "Ada likes tea"));
    assert.ok(!forEight.some(m => m.content === "Ada duelled the harbor master"));
    assert.ok(forEight.some(m => m.content === "Ada likes tea"));
    assert.ok(!forNone.some(m => m.content === "Ada duelled the harbor master"));
  } finally { await sql.end(); }
});

test("in_fiction evidence normalizes to story_fact even on a person kind", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const cid = await companionRow(sql);
    await store.setMemberOptIn("g1", "u1", true);
    const extraction: ExtractionResult = {
      memories: [
        // Extractor marked the beat fiction but left kind as person_fact —
        // persistExtraction must still route it to the fiction lane.
        { subjectId: "unknown", subjectName: "Ada", kind: "person_fact", content: "Ada is secretly a dragon", reason: "t", evidenceType: "in_fiction", effect: "support" },
      ],
      relationships: [],
    };
    await persistExtraction(extraction, msg(), { store, aliases: new Map([["ada", "u1"]]), isConsented: CONSENT_ALL, companionId: cid });
    const rows = await sql<Array<{ kind: string; companion_id: number | null }>>`
      SELECT kind, companion_id FROM memories WHERE guild_id = 'g1'`;
    assert.equal(rows[0].kind, "story_fact");
    assert.equal(Number(rows[0].companion_id), cid);
  } finally { await sql.end(); }
});

test("unscoped story facts (ambient server message) are inert in recall", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u1", true);
    const extraction: ExtractionResult = {
      memories: [
        { subjectId: "unknown", subjectName: "Ada", kind: "story_fact", content: "Ada claimed the throne", reason: "t", evidenceType: "in_fiction", effect: "support" },
      ],
      relationships: [],
    };
    // No companionId — the message had no addressee. It must not leak into
    // shared recall as a real-world claim.
    await persistExtraction(extraction, msg(), { store, aliases: new Map([["ada", "u1"]]), isConsented: CONSENT_ALL });
    for (const companionId of [undefined, null, 7]) {
      const rec = await store.relevantMemories("g1", "u1", 10, companionId);
      assert.ok(!rec.some(m => m.content === "Ada claimed the throne"), `companion ${companionId} should not see unscoped fiction`);
    }
  } finally { await sql.end(); }
});

test("story facts stay out of the digest and search surfaces", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const cid = await companionRow(sql);
    await store.setMemberOptIn("g1", "u1", true);
    await store.setMemberShareFacts("g1", "u1", true);
    await store.pinFact(msg(), "Kael lost his sword in the raid", "u1", cid, "story_fact");
    await store.pinFact(msg(), "Ada hates raisins", "u1");

    const digest = await store.recentMemories("g1", 10, { status: "active", digestFor: "u1" });
    assert.ok(digest.some(m => m.content === "Ada hates raisins"));
    assert.ok(!digest.some(m => m.content === "Kael lost his sword in the raid"), "story facts never ride the digest");

    const found = await store.searchMemories("g1", "sword");
    assert.equal(found.length, 0);
    const foundReal = await store.searchMemories("g1", "raisins");
    assert.equal(foundReal.length, 1);
  } finally { await sql.end(); }
});

test("digest excludes other members' facts until they opt into sharing", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // u-bob is memory-opted-in but has NOT enabled share-facts; u-owner is the
    // DM digest recipient.
    await store.setMemberOptIn("g1", "u-owner", true);
    await store.setMemberOptIn("g1", "u-bob", true);
    await store.pinFact(msg({ authorId: "u-bob", authorName: "Bob" }), "Bob plays the lute", "u-bob");
    await store.pinFact(msg(), "Owner fact", "u-owner");
    // pinFact for lore too — saveMemory alone lands 'candidate', and the
    // digest lane is active-only.
    await store.pinFact(msg(), "the guild meets on Thursdays", "server", null, "server_lore");

    // Restricted lane: server lore + owner's own facts only — Bob's stays home.
    const restricted = await store.recentMemories("g1", 10, { status: "active", digestFor: "u-owner" });
    const contents = restricted.map(m => m.content);
    assert.ok(contents.includes("the guild meets on Thursdays"));
    assert.ok(contents.includes("Owner fact"));
    assert.ok(!contents.includes("Bob plays the lute"));

    // Bob opts into sharing → his facts cross.
    await store.setMemberShareFacts("g1", "u-bob", true);
    const shared = await store.recentMemories("g1", 10, { status: "active", digestFor: "u-owner" });
    assert.ok(shared.some(m => m.content === "Bob plays the lute"));
  } finally { await sql.end(); }
});

test("pinned memories always lead recall, even past the limit", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u1", true);
    // Fill the spine with un-pinned high-importance facts. Update by the row
    // pinFact actually returned — near-identical contents may trigram-merge,
    // and pinning lands on the merged row, not the string.
    for (let i = 0; i < 12; i++) {
      const m = await store.pinFact(msg(), `ordinary fact ${i}`, "u1");
      await sql`UPDATE memories SET pinned = FALSE, importance = 0.95, confidence = 0.95 WHERE id = ${m.id}`;
    }
    await store.pinFact(msg(), "pinned truth", "u1");
    const rec = await store.relevantMemories("g1", "u1", 8);
    assert.ok(rec.some(m => m.content === "pinned truth"), "the pinned memory must surface despite 12 higher-ranked rows");
    assert.equal(rec[0].content, "pinned truth");
  } finally { await sql.end(); }
});

test("memory pin/unpin flips the flag and survives recall", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u1", true);
    await store.pinFact(msg(), "first pinned", "u1");
    const mem = (await store.listMemories("g1", "u1", {})).memories[0];
    assert.equal(mem.pinned, true);
    await store.setMemoryPinned("g1", mem.id, false);
    const after = await store.getMemory("g1", mem.id);
    assert.equal(after?.pinned, false);
  } finally { await sql.end(); }
});

test("summaries: counter claim is atomic; user_edited flag round-trips", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const cid = await companionRow(sql);

    for (let i = 0; i < 9; i++) assert.equal(await store.bumpStoryCounter(cid, "g1", "c1"), i + 1);
    assert.equal(await store.claimStoryUpdate(cid, "g1", "c1", 10), false, "under threshold — no claim");
    assert.equal(await store.bumpStoryCounter(cid, "g1", "c1"), 10);
    assert.equal(await store.claimStoryUpdate(cid, "g1", "c1", 10), true, "threshold crossed — claims and resets");
    assert.equal(await store.claimStoryUpdate(cid, "g1", "c1", 10), false, "second claim loses the race");

    // unclaimStoryUpdate re-arms a claim whose enqueue failed — the counter
    // goes back to threshold so the next bump re-fires the claim instead of
    // the fold silently covering a double window.
    await store.bumpStoryCounter(cid, "g1", "c1");
    await store.unclaimStoryUpdate(cid, "g1", "c1", 10);
    assert.equal(await store.claimStoryUpdate(cid, "g1", "c1", 10), true, "re-armed claim refires");
    assert.equal(await store.claimStoryUpdate(cid, "g1", "c1", 10), false, "reclaimed counter resets cleanly");

    await store.setStoryUserText(cid, "g1", "c1", "We escaped the castle, Kael is wounded.");
    const row = await store.getStorySummary(cid, "g1", "c1");
    assert.equal(row?.summary, "We escaped the castle, Kael is wounded.");
    assert.equal(row?.userEdited, true);
    assert.equal(row?.msgsSince, 0, "claim reset survived the summary upsert");

    const chans = await store.summariesForChannel("g1", "c1");
    assert.equal(chans.length, 1);
    assert.equal(await store.deleteStorySummary(cid, "g1", "c1"), 1);
    assert.equal(await store.getStorySummary(cid, "g1", "c1"), null);
  } finally { await sql.end(); }
});

test("reset-story keeps the row and parks the watermark — the backlog can't re-fold", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const cid = await companionRow(sql);
    // 30 backlog messages, one minute apart, oldest 60 min ago.
    for (let i = 0; i < 30; i++) {
      await sql`INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at)
        VALUES (${`mm-${i}`}, 'g1', 'c1', 'u1', 'Ada', ${`old beat ${i}`}, ${new Date(Date.now() - (60 - i) * 60_000)})`;
    }
    await store.setStoryUserText(cid, "g1", "c1", "The party set out from the inn.");
    // Watermark at -55min: 4 messages (-54..-51) sit between it and the
    // keepRecent boundary (-51min for 30 messages, keepRecent 20).
    const watermark = new Date(Date.now() - 55 * 60_000).toISOString();
    const before = await store.storyWindow("g1", "c1", watermark, 20, 60);
    assert.equal(before.length, 4, "post-watermark backlog folds normally");

    assert.equal(await store.resetStorySummary(cid, "g1", "c1"), 1);
    const row = await store.getStorySummary(cid, "g1", "c1");
    assert.ok(row, "the row survives — deleting it used to reset covered_until to epoch");
    assert.equal(row?.summary, "");
    assert.equal(row?.userEdited, false);
    assert.equal(row?.msgsSince, 0);
    const win = await store.storyWindow("g1", "c1", row!.coveredUntil, 20, 60);
    assert.equal(win.length, 0, "nothing older than the parked watermark can re-fold into the 'cleared' recap");
  } finally { await sql.end(); }
});

test("setStoryUserText upserts on a rowless lane; fold clears user_edited and can't clobber a newer edit", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const cid = await companionRow(sql);
    // The story modal can open with no row — the write must insert, not no-op.
    await store.setStoryUserText(cid, "g1", "c1", "Owner canon: we reached the citadel.");
    const row = await store.getStorySummary(cid, "g1", "c1");
    assert.equal(row?.summary, "Owner canon: we reached the citadel.");
    assert.equal(row?.userEdited, true);

    // A fold holding THIS row's timestamp writes and clears the flag —
    // machine output is not owner-authored canon.
    await store.upsertStorySummary(cid, "g1", "c1", "Citadel recap folded", "2030-01-01T00:00:00Z", row!.updatedAt);
    const folded = await store.getStorySummary(cid, "g1", "c1");
    assert.equal(folded?.summary, "Citadel recap folded");
    assert.equal(folded?.userEdited, false);

    // A fold that read before a newer edit must drop rather than clobber.
    await new Promise(r => setTimeout(r, 5));
    const staleRead = folded!.updatedAt;
    await store.setStoryUserText(cid, "g1", "c1", "Fresh owner canon");
    await store.upsertStorySummary(cid, "g1", "c1", "Stale machine text", "2030-01-02T00:00:00Z", staleRead);
    const after = await store.getStorySummary(cid, "g1", "c1");
    assert.equal(after?.summary, "Fresh owner canon", "a stale fold must not overwrite a newer user edit");
    assert.equal(after?.userEdited, true);
  } finally { await sql.end(); }
});

test("pinning promotes a gated memory to active; forgotten and superseded rows refuse", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u1", true);
    // Non-promotable evidence → stays 'candidate' until the user pins it.
    const cand = await store.saveMemory(msg(), {
      subjectId: "u1", kind: "person_fact", content: "Ada supposedly hates cats",
      reason: "t", evidenceType: "sarcasm_or_joke", effect: "support",
    });
    assert.equal(cand.status, "candidate");
    await store.setMemoryPinned("g1", cand.id, true);
    const promoted = await store.getMemory("g1", cand.id);
    assert.equal(promoted?.status, "active", "pinning is itself the assertion — a pinned candidate rides recall");
    assert.equal(promoted?.pinned, true);

    const dead = await store.pinFact(msg(), "Ada once had a twin", "u1");
    await sql`UPDATE memories SET status = 'superseded', pinned = FALSE WHERE id = ${dead.id}`;
    assert.equal(await store.setMemoryPinned("g1", dead.id, true), false);
    await sql`UPDATE memories SET status = 'forgotten' WHERE id = ${dead.id}`;
    assert.equal(await store.setMemoryPinned("g1", dead.id, true), false);
  } finally { await sql.end(); }
});

test("pinFact resurrects a forgotten dup but can't revive a superseded one", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u1", true);
    const first = await store.pinFact(msg(), "Ada keeps a journal", "u1");
    await sql`UPDATE memories SET status = 'forgotten', pinned = FALSE WHERE id = ${first.id}`;
    const back = await store.pinFact(msg(), "Ada keeps a journal", "u1");
    assert.equal(back.id, first.id, "exact dup reuses the row");
    assert.equal(back.pinned, true, "a forgotten dup re-asserted by the subject comes back pinned");

    const sup = await store.pinFact(msg(), "Ada lives in the lighthouse", "u1");
    await sql`UPDATE memories SET status = 'superseded', pinned = FALSE WHERE id = ${sup.id}`;
    const stillDead = await store.pinFact(msg(), "Ada lives in the lighthouse", "u1");
    assert.equal(stillDead.id, sup.id);
    assert.equal(stillDead.pinned, false, "a superseded row stays dead — reviving it would twin the replacement");
  } finally { await sql.end(); }
});

test("the stale sweep spares story facts but still reaps stale real facts", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const cid = await companionRow(sql);
    await store.setMemberOptIn("g1", "u1", true);
    await store.pinFact(msg(), "Nyx remembers the duel", "u1", cid, "story_fact");
    await store.pinFact(msg(), "Ada had a cat", "u1");
    // Unpin both and age them past the stale cutoff at fiction-level confidence.
    await sql`UPDATE memories SET pinned = FALSE, confidence = 0.6,
      last_confirmed_at = NOW() - INTERVAL '120 days' WHERE guild_id = 'g1'`;
    await store.maintain("g1");
    const rows = await sql<Array<{ kind: string; status: string }>>`SELECT kind, status FROM memories WHERE guild_id = 'g1'`;
    assert.equal(rows.find(r => r.kind === "story_fact")?.status, "active",
      "story facts start at 0.6 by design — the generic 0.75 ladder can't reap them");
    assert.equal(rows.find(r => r.kind === "person_fact")?.status, "quarantined");
  } finally { await sql.end(); }
});

test("digest relays another member's companion facts only with the owner's consent", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const bobCid = await companionRow(sql, "u-bob");
    const ownCid = await companionRow(sql, "u-owner");
    await store.setMemberOptIn("g1", "u-owner", true);
    await store.setMemberOptIn("g1", "u-bob", true);
    // Companion self-memories in real kinds — story facts never ride the digest.
    await store.pinFact(msg({ authorId: "u-bob", authorName: "Bob" }), "Bob's companion collects knives", `companion:${bobCid}`);
    await store.pinFact(msg(), "Owner's companion loves toast", `companion:${ownCid}`);

    const restricted = await store.recentMemories("g1", 10, { status: "active", digestFor: "u-owner" });
    const contents = restricted.map(m => m.content);
    assert.ok(contents.includes("Owner's companion loves toast"), "the recipient's own companion always passes");
    assert.ok(!contents.includes("Bob's companion collects knives"), "Bob's companion is gated on Bob's share flag");

    await store.setMemberShareFacts("g1", "u-bob", true);
    const shared = await store.recentMemories("g1", 10, { status: "active", digestFor: "u-owner" });
    assert.ok(shared.some(m => m.content === "Bob's companion collects knives"), "the owner's opt-in lets it cross");
  } finally { await sql.end(); }
});

test("canManageCompanion honors the owner and refuses strangers", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const cid = await companionRow(sql, "u1");
    assert.equal(await store.canManageCompanion("u1", cid), true);
    assert.equal(await store.canManageCompanion("u-stranger", cid), false);
  } finally { await sql.end(); }
});

test("companion deletion cascades its story facts and summaries", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const cid = await companionRow(sql);
    await store.setMemberOptIn("g1", "u1", true);
    await store.pinFact(msg(), "Nyx's tale beat", "u1", cid, "story_fact");
    await store.pinFact(msg(), "Ada real fact", "u1");
    await store.setStoryUserText(cid, "g1", "c1", "recap");

    await sql`DELETE FROM companions WHERE id = ${cid}`;
    const mems = await sql<Array<{ kind: string }>>`SELECT kind FROM memories WHERE guild_id = 'g1'`;
    assert.deepEqual(mems.map(m => m.kind), ["person_fact"], "story facts cascade with the companion");
    const sums = await sql`SELECT id FROM conversation_summaries WHERE companion_id = ${cid}`;
    assert.equal(sums.length, 0, "summaries cascade too");
  } finally { await sql.end(); }
});
