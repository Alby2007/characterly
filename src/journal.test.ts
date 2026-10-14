import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { Brain, type LlmClient } from "./brain.js";
import { MemoryStore } from "./database.js";
import { runJournalJob } from "./journal-job.js";
import { clearData, makeStore, makeTestSql } from "./test-helpers.js";
import type { JournalCandidate, MessageEvent } from "./types.js";

const SPEC = {
  name: "Nyx",
  voicePersona: "Dry, witty",
  coreTraits: ["witty", "loyal"],
  ownerDynamic: "Best friend",
  backstory: "",
  avatarUrl: null,
};

function msg(content: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1", channelId: "c1", messageId: `m-${Math.random().toString(36).slice(2)}`,
    authorId: "u-alice", authorName: "Alice", content,
    createdAt: new Date(), mentionsBot: false, ...overrides,
  };
}

const alwaysConsent = async () => true;

async function seedCompanion(store: MemoryStore) {
  const comp = await store.activateCompanion("u-alice", "Alice", SPEC);
  await store.summonCompanion("g1", comp.id, "u-alice", "Alice");
  return comp;
}

// ── Brain.writeJournal (unit, no DB) ────────────────────────────────────────

test("Brain.writeJournal prompts for first-person own-experience entries and tolerates malformed output", async () => {
  let captured = "";
  const fakeClient: LlmClient = {
    responses: { create: async () => ({ output_text: "{}" }) },
    chat: {
      completions: {
        create: async (params: any) => {
          captured = params.messages[0].content;
          return { choices: [{ message: { content: JSON.stringify({ entries: [
            { kind: "inside_joke", content: "Alice and I roasted her tea take", importance: 0.7, aboutSubjects: ["u-alice"] },
          ] }) } }] };
        },
      },
    },
  };
  const brain = new Brain("test-key", "test-model", undefined, fakeClient);
  const entries = await brain.writeJournal({
    name: "Nyx", voicePersona: "Dry", coreTraits: ["witty"],
    context: "Alice (u-alice): tea is just leaf water\nyou: correct and yet here we are",
    reply: "correct and yet here we are",
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "inside_joke");
  assert.match(captured, /first-person/);
  assert.match(captured, /YOUR REPLY/);
  assert.match(captured, /u-alice/); // ids shown so aboutSubjects resolve

  // A provider returning junk or throwing yields [] rather than an error.
  const badClient: LlmClient = {
    responses: { create: async () => ({ output_text: "{}" }) },
    chat: { completions: { create: async () => ({ choices: [{ message: { content: "not json at all" } }] }) } },
  };
  const badBrain = new Brain("test-key", "test-model", undefined, badClient);
  assert.deepEqual(await badBrain.writeJournal({ name: "Nyx", voicePersona: "", coreTraits: [], context: "", reply: "hi" }), []);
});

// ── Persistence, origin scoping, consent ────────────────────────────────────

test("journal entries persist first-person, recall only in their origin scope", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const comp = await seedCompanion(store);

    const saved = await store.saveJournalEntries(comp.id, "g1", [
      { kind: "moment", content: "Bob dared me to rap about the server rules and I did", importance: 0.8, aboutSubjects: ["u-bob"] },
    ], "reply-1", alwaysConsent);
    assert.equal(saved, 1);

    const g1Entries = await store.journalFor(comp.id, "g1");
    assert.equal(g1Entries.length, 1);
    assert.equal(g1Entries[0].kind, "moment");
    assert.deepEqual(g1Entries[0].aboutSubjectIds, ["u-bob"]);
    assert.equal(g1Entries[0].originScope, "g1");

    // Origin isolation: a second guild and the owner's DM see nothing.
    assert.equal((await store.journalFor(comp.id, "g2")).length, 0);
    assert.equal((await store.journalFor(comp.id, "dm:u-alice")).length, 0);
  } finally { await sql.end(); }
});

test("write-time consent filter drops entries about non-consenting humans; companions pass", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const comp = await seedCompanion(store);
    // u-bob never opted in → entries about him are dropped at write time.
    const isConsented = async (s: string) => s === "u-alice" || s.startsWith("companion:");
    const saved = await store.saveJournalEntries(comp.id, "g1", [
      { kind: "moment", content: "Bob showed me his cursed spreadsheet", aboutSubjects: ["u-bob"] },
      { kind: "moment", content: "Alice and I rebuilt the tier list again", aboutSubjects: ["u-alice", "companion:9"] },
      { kind: "opinion", content: "quiet night, just me thinking", aboutSubjects: [] },
    ], "reply-2", isConsented);
    assert.equal(saved, 2);
    const entries = await store.journalFor(comp.id, "g1");
    assert.equal(entries.length, 2);
    assert.ok(!entries.some(e => e.aboutSubjectIds.includes("u-bob")));
  } finally { await sql.end(); }
});

test("opt-out filters the subject out of recall and forgetJournalAbout hard-deletes", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const comp = await seedCompanion(store);
    await store.setMemberOptIn("g1", "u-bob", true);
    await store.saveJournalEntries(comp.id, "g1", [
      { kind: "moment", content: "Bob and I argued about pizza toppings for an hour", importance: 0.9, aboutSubjects: ["u-bob"] },
      { kind: "moment", content: "I finally beat the raid boss", importance: 0.9, aboutSubjects: [] },
    ], "reply-3", alwaysConsent);
    assert.equal((await store.journalFor(comp.id, "g1")).length, 2);

    // Bob opts out → his entries stop surfacing immediately (read-time filter).
    await store.setMemberOptOut("g1", "u-bob", true);
    const afterOptOut = await store.journalFor(comp.id, "g1");
    assert.equal(afterOptOut.length, 1);
    assert.equal(afterOptOut[0].content, "I finally beat the raid boss");

    // /opt-out then hard-deletes the rows about him.
    const deleted = await store.forgetJournalAbout("g1", "u-bob");
    assert.equal(deleted, 1);
    assert.equal((await store.journalAboutSubject("g1", "u-bob")).length, 0);
  } finally { await sql.end(); }
});

test("purgeGuild wipes that scope's journal but not the companion's other scopes", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const comp = await seedCompanion(store);
    await store.saveJournalEntries(comp.id, "g1", [{ kind: "moment", content: "g1 thing", aboutSubjects: [] }], "r-a", alwaysConsent);
    await store.saveJournalEntries(comp.id, "dm:u-alice", [{ kind: "promise", content: "promised Alice I'd remind her", aboutSubjects: ["u-alice"] }], "r-b", alwaysConsent);

    await store.purgeGuild("g1");
    assert.equal((await store.journalFor(comp.id, "g1")).length, 0);
    assert.equal((await store.journalFor(comp.id, "dm:u-alice")).length, 1);

    // Zombie sweep sees journal origin scopes too.
    await store.saveJournalEntries(comp.id, "g-zombie", [{ kind: "moment", content: "orphan entry", aboutSubjects: [] }], "r-c", alwaysConsent);
    assert.deepEqual(await store.guildsNotIn(["g1"]), ["g-zombie"]);
  } finally { await sql.end(); }
});

test("exportSubject surfaces journal entries about the user", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const comp = await seedCompanion(store);
    await store.saveJournalEntries(comp.id, "g1", [
      { kind: "inside_joke", content: "Alice's leaf-water take still haunts me", aboutSubjects: ["u-alice"] },
      { kind: "moment", content: "solo reflection, no one involved", aboutSubjects: [] },
    ], "r-d", alwaysConsent);
    const data = await store.exportSubject("g1", "u-alice");
    assert.equal(data.journal.length, 1);
    assert.match(data.journal[0].content, /leaf-water/);
  } finally { await sql.end(); }
});

test("pruneJournal evicts past the per-scope cap, keeping higher-importance entries", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const comp = await seedCompanion(store);
    // Distinct content per entry — near-identical strings would be caught by
    // the trigram dedup before the unique constraint is even reached.
    const bodies = [
      "Alice dared me to rap the rules", "I lost the rap battle badly",
      "rainy Tuesday vibes hit different", "we rebuilt the tier list again",
      "the great pizza summit of today",
    ];
    for (let i = 0; i < 5; i++) {
      await store.saveJournalEntries(comp.id, "g1", [
        { kind: "moment", content: bodies[i], importance: i === 4 ? 0.99 : 0.1, aboutSubjects: [] },
      ], `r-p-${i}`, alwaysConsent);
    }
    const pruned = await store.pruneJournal(3);
    assert.equal(pruned, 2);
    const kept = await store.journalFor(comp.id, "g1", { limit: 10 });
    assert.equal(kept.length, 3);
    assert.ok(kept.some(e => e.content.includes("pizza summit")), "the high-importance entry survives");
  } finally { await sql.end(); }
});

// ── runJournalJob end-to-end ────────────────────────────────────────────────

test("runJournalJob journals a real archived exchange and drops stale/dormant jobs", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const comp = await seedCompanion(store);
    await store.setMemberOptIn("g1", "u-alice", true);

    const trigger = msg("Nyx, rate my terrible tea opinion", { messageId: "trig-1" });
    await store.recordMessage(trigger);
    const reply = msg("leaf water is a crime and I'll die on this hill", { messageId: "rep-1", authorId: `companion:${comp.id}`, authorName: "Nyx" });
    await store.recordMessage(reply, trigger.messageId, false, true);

    const calls: any[] = [];
    const fakeBrain = {
      writeJournal: async (opts: any) => {
        calls.push(opts);
        return [{ kind: "inside_joke", content: "Alice's tea take is a crime we now share", importance: 0.6, aboutSubjects: ["u-alice"] } satisfies JournalCandidate];
      },
    };
    const deps = { store, brainFor: async () => fakeBrain as any as Brain, botId: "bot-1" };

    await runJournalJob("g1", { companionId: comp.id, triggerMessageId: "trig-1", replyMessageId: "rep-1", channelId: "c1" }, deps);
    assert.equal(calls.length, 1);
    assert.match(calls[0].context, /Alice \(u-alice\)/);
    const entries = await store.journalFor(comp.id, "g1");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sourceMessageId, "rep-1");

    // Deleted trigger → job drops, no new write.
    await sql`DELETE FROM messages WHERE id = 'trig-2'`.catch(() => {});
    calls.length = 0;
    await runJournalJob("g1", { companionId: comp.id, triggerMessageId: "trig-2", replyMessageId: "rep-1", channelId: "c1" }, deps);
    assert.equal(calls.length, 0);

    // Dormant brain (no BYOK key) → drop.
    await runJournalJob("g1", { companionId: comp.id, triggerMessageId: "trig-1", replyMessageId: "rep-1", channelId: "c1" }, { ...deps, brainFor: async () => null });
    assert.equal(calls.length, 0);
  } finally { await sql.end(); }
});

test("journal-write jobs are idempotent across retries via the unique constraint", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const comp = await seedCompanion(store);
    await store.setMemberOptIn("g1", "u-alice", true);
    const trigger = msg("remember this Nyx", { messageId: "trig-9" });
    await store.recordMessage(trigger);
    const reply = msg("noted forever", { messageId: "rep-9", authorId: `companion:${comp.id}`, authorName: "Nyx" });
    await store.recordMessage(reply, trigger.messageId, false, true);

    const fakeBrain = { writeJournal: async () => [{ kind: "promise", content: "I promised to remember this", aboutSubjects: ["u-alice"] } satisfies JournalCandidate] };
    const deps = { store, brainFor: async () => fakeBrain as any as Brain, botId: "bot-1" };
    const payload = { companionId: comp.id, triggerMessageId: "trig-9", replyMessageId: "rep-9", channelId: "c1" };
    await runJournalJob("g1", payload, deps);
    await runJournalJob("g1", payload, deps); // retry after a crash mid-commit
    assert.equal((await store.journalFor(comp.id, "g1")).length, 1);
  } finally { await sql.end(); }
});

// ── Reply prompt integration ────────────────────────────────────────────────

test("Brain.reply renders the journal block as first-person entries with hedging guidance", async () => {
  let lastInput = "";
  const fakeClient: LlmClient = {
    responses: { create: async () => ({ output_text: "{}" }) },
    chat: { completions: { create: async (p: any) => { lastInput = p.messages[0].content; return { choices: [{ message: { content: JSON.stringify({ text: "ha", end_conversation: false }) } }] }; } } },
  };
  const brain = new Brain("test-key", "test-model", undefined, fakeClient);
  await brain.reply(
    msg("remember the tea thing?"), [], [], [], [], undefined, false, "companion:1",
    {
      guildName: "Hangout", botName: "Nyx", isDm: false,
      companion: {
        companionId: 1, name: "Nyx", ownerUserId: "u-alice", voicePersona: "dry",
        coreTraits: [], ownerDynamic: "", backstory: "",
        journal: [{ id: 1, companionId: 1, originScope: "g1", kind: "inside_joke", content: "Alice and I roasted her tea take", aboutSubjectIds: ["u-alice"], importance: 0.7, status: "active", createdAt: "" }],
      },
    },
  );
  assert.match(lastInput, /Your journal/);
  assert.match(lastInput, /Alice and I roasted her tea take/);
  assert.match(lastInput, /hedge older or lower-importance/);
});
