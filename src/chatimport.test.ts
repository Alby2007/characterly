import "dotenv/config";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { makeStore, makeTestSql } from "./test-helpers.js";
import { runChatImportJob } from "./chat-import-job.js";
import { FatalJobError } from "./jobs.js";
import type { MemoryStore } from "./database.js";

const sql = makeTestSql();
after(() => sql.end());

function freshStore() {
  return makeStore(sql);
}

async function awakenedCompanion(store: MemoryStore, userId: string, name = "Nyx") {
  return store.activateCompanion(userId, "Owner", {
    name,
    voicePersona: "dry, sharp",
    coreTraits: ["witty"],
    ownerDynamic: "ride-or-die",
    backstory: "met in a chat",
    avatarUrl: null,
  });
}

const turns = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    speaker: (i % 2 ? "char" : "user") as "char" | "user",
    text: `turn ${i}`,
    ts: `2024-05-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
  }));

function importOpts(name = "past-chat.jsonl", sha = `sha-${Math.random()}`) {
  return {
    filename: name, sha256: sha, format: "jsonl",
    turns: turns(65),
    speakers: { user: "Alby", char: "Nyx" },
    meta: { source: "chat_history" },
  };
}

/** Fake brain — one moment per window + an evolving rolling summary.
 *  Content must differ enough per call to survive the journal's trgm dedupe. */
function fakeBrain(calls: string[] = []) {
  return {
    async distillHistoryWindow(opts: { windowText: string }) {
      calls.push(opts.windowText);
      return {
        entries: [{
          kind: "moment" as const,
          content: [
            "we stayed up past three inventing constellations that don't exist",
            "they taught me their grandmother's dumpling fold and I got it wrong twice",
            "the power went out and we finished the story in the dark anyway",
          ][(calls.length - 1) % 3],
          importance: 0.6,
        }],
        summary: `we'd talked ${calls.length} window(s) in`,
      };
    },
  };
}

function jobDeps(store: MemoryStore, brain: unknown, sent: string[] = []) {
  return {
    store,
    brainFor: async () => brain as never,
    maxWindows: 50,
    windowSize: 30,
    sendDm: async (_uid: string, content: string) => { sent.push(content); },
  };
}

test("chat_imports schema + journal provenance columns exist", async () => {
  await freshStore();
  const cols = await sql<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'companion_journal' AND column_name IN ('source', 'import_id')
  `;
  assert.equal(cols.length, 2);
  const t = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables WHERE table_name = 'chat_imports'`;
  assert.equal(t.length, 1);
});

test("chat import lifecycle — create, dedupe, claim, progress, done", async () => {
  const { store } = await freshStore();
  const comp = await awakenedCompanion(store, "u-hist");

  const imp = await store.createChatImport("u-hist", comp.id, importOpts());
  assert.equal(imp.status, "queued");
  assert.equal(imp.turns.length, 65);
  assert.equal(imp.messageCount, 65);

  // Same sha256 → same row back (unique-violation dedupe).
  const dupe = await store.createChatImport("u-hist", comp.id, importOpts("other-name.jsonl", imp.sha256));
  assert.equal(dupe.id, imp.id);
  const found = await store.findChatImportByHash("u-hist", imp.sha256);
  assert.equal(found?.id, imp.id);
  assert.equal(await store.findChatImportByHash("u-hist", "nope"), null);

  assert.equal(await store.activeChatImportCount("u-hist"), 1);

  // Claim moves queued→distilling exactly once.
  assert.equal(await store.claimChatImport(imp.id), true);
  assert.equal(await store.claimChatImport(imp.id), false);
  assert.equal((await store.chatImportById(imp.id))?.status, "distilling");

  // Progress checkpoint — counts + the rolling summary in meta.
  await store.updateChatImportProgress(imp.id, 30, 2, "we were getting close");
  let cur = await store.chatImportById(imp.id);
  assert.equal(cur?.processedTurns, 30);
  assert.equal(cur?.keptCount, 2);
  assert.equal((cur?.meta as Record<string, unknown>)?.rollingSummary, "we were getting close");

  // Done — transcript discarded, counts + provenance kept.
  await store.completeChatImport(imp.id);
  cur = await store.chatImportById(imp.id);
  assert.equal(cur?.status, "done");
  assert.equal(cur?.turns.length, 0);
  assert.equal(await store.activeChatImportCount("u-hist"), 0);
});

test("saveImportedJournalEntries — provenance, backdate, bond kind, consent", async () => {
  const { store } = await freshStore();
  const comp = await awakenedCompanion(store, "u-jrnl");
  const imp = await store.createChatImport("u-jrnl", comp.id, importOpts());

  const saved = await store.saveImportedJournalEntries(
    comp.id, "dm:u-jrnl",
    [
      { kind: "moment", content: "we stayed up talking about the stars", importance: 0.6 },
      { kind: "promise", content: "I said I'd remember their dog's name", importance: 0.8, aboutSubjects: ["u-jrnl"] },
      { kind: "bond", content: "Before Characterly — they were my whole evening", importance: 0.95 },
      { kind: "moment", content: "blocked-by-consent", importance: 0.5, aboutSubjects: ["stranger-1"] },
    ],
    imp.id, "2024-05-02T00:00:00Z",
    async subjectId => subjectId !== "stranger-1",
  );
  assert.equal(saved.length, 3);

  const rows = await sql<Array<{ kind: string; source: string; import_id: number | null; created_at: Date }>>`
    SELECT kind, source, import_id, created_at FROM companion_journal
    WHERE companion_id = ${comp.id} ORDER BY importance DESC`;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, "bond");
  assert.ok(rows.every(r => r.source === "import" && Number(r.import_id) === imp.id));
  assert.equal(rows[0].created_at.toISOString(), "2024-05-02T00:00:00.000Z");
});

test("failChatImport — transcript cleared AND partial journal retracted", async () => {
  const { store } = await freshStore();
  const comp = await awakenedCompanion(store, "u-fail");
  const imp = await store.createChatImport("u-fail", comp.id, importOpts());
  await store.claimChatImport(imp.id);
  await store.saveImportedJournalEntries(
    comp.id, "dm:u-fail",
    [{ kind: "moment", content: "a memory that shouldn't survive failure", importance: 0.5 }],
    imp.id, "2024-05-02T00:00:00Z", async () => true,
  );
  let n = await sql<[{ c: number | string }]>`
    SELECT COUNT(*) AS c FROM companion_journal WHERE import_id = ${imp.id}`;
  assert.equal(Number(n[0].c), 1);

  await store.failChatImport(imp.id, "kaboom");
  const cur = await store.chatImportById(imp.id);
  assert.equal(cur?.status, "failed");
  assert.equal(cur?.error, "kaboom");
  assert.equal(cur?.turns.length, 0);
  n = await sql<[{ c: number | string }]>`
    SELECT COUNT(*) AS c FROM companion_journal WHERE import_id = ${imp.id}`;
  assert.equal(Number(n[0].c), 0);
});

test("job — windows distill to journal, bond pinned, transcript discarded, DM sent", async () => {
  const { store } = await freshStore();
  const comp = await awakenedCompanion(store, "u-job");
  const imp = await store.createChatImport("u-job", comp.id, importOpts());
  const calls: string[] = [];
  const sent: string[] = [];

  await runChatImportJob("dm:u-job", { importId: imp.id }, jobDeps(store, fakeBrain(calls), sent));

  assert.equal(calls.length, 3); // 65 turns @ 30/window → 3 windows
  const cur = await store.chatImportById(imp.id);
  assert.equal(cur?.status, "done");
  assert.equal(cur?.turns.length, 0);
  assert.equal(cur?.processedTurns, 65);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /memories|moments/i);

  const rows = await sql<Array<{ kind: string; source: string; created_at: Date }>>`
    SELECT kind, source, created_at FROM companion_journal
    WHERE companion_id = ${comp.id} AND import_id = ${imp.id}
    ORDER BY importance ASC`; // moments are 0.6, the bond is 0.95 → deterministic last
  // 3 window entries + the pinned bond.
  assert.equal(rows.length, 4);
  assert.equal(rows[3].kind, "bond");
  assert.ok(rows.every(r => r.source === "import"));
  assert.match(rows[3].created_at.toISOString(), /^2024-05-01/);
});

test("job — hosted lane bills per window; BYOK lane never touches the ledger", async () => {
  const { store } = await freshStore();
  const comp = await awakenedCompanion(store, "u-bill");
  const imp = await store.createChatImport("u-bill", comp.id, importOpts()); // 65 turns → 3 windows

  let spends = 0;
  (store as any).accountForDiscordUser = async () => ({ id: "acct", plan: "free", creditBalance: 99 });
  (store as any).spendCredits = async () => { spends++; return { ok: true, balance: 0 }; };

  // BYOK lane: isHostedScope false → no ledger interaction at all.
  await runChatImportJob("dm:u-bill", { importId: imp.id },
    { ...jobDeps(store, fakeBrain()), isHostedScope: () => false });
  assert.equal(spends, 0, "BYOK imports burn the user's own provider, not tokens");
  assert.equal((await store.chatImportById(imp.id))?.status, "done");

  // Hosted lane: one spend per window — a 65-turn import pays 3.
  const imp2 = await store.createChatImport("u-bill", comp.id, importOpts("b.jsonl"));
  await runChatImportJob("dm:u-bill", { importId: imp2.id },
    { ...jobDeps(store, fakeBrain()), isHostedScope: () => true });
  assert.equal(spends, 3);
});

test("job — empty wallet parks the import (CreditsExhausted), unlink fails it", async () => {
  const { store } = await freshStore();
  const comp = await awakenedCompanion(store, "u-capped");
  const imp = await store.createChatImport("u-capped", comp.id, importOpts());

  // Hosted lane with a linked account whose wallet covers exactly one window.
  (store as any).accountForDiscordUser = async () => ({ id: "acct", plan: "free", creditBalance: 0 });
  let spends = 0;
  (store as any).spendCredits = async () => { spends++; return { ok: spends <= 1, balance: 0 }; };
  const err = await runChatImportJob("dm:u-capped", { importId: imp.id },
    { ...jobDeps(store, fakeBrain()), isHostedScope: () => true }).then(() => null, e => e);
  assert.equal((err as Error).name, "CreditsExhausted");
  const cur = await store.chatImportById(imp.id);
  assert.equal(cur?.status, "distilling", "a parked import stays resumable, not failed");
  assert.equal(cur?.processedTurns, 30, "the paid window still committed");

  // Mid-import unlink is permanent — fail the row, don't park it forever.
  const imp2 = await store.createChatImport("u-capped", comp.id, importOpts("c.jsonl"));
  (store as any).accountForDiscordUser = async () => null;
  await runChatImportJob("dm:u-capped", { importId: imp2.id },
    { ...jobDeps(store, fakeBrain()), isHostedScope: () => true });
  assert.equal((await store.chatImportById(imp2.id))?.status, "failed");
});

test("job — a window that throws refunds its charge", async () => {
  const { store } = await freshStore();
  const comp = await awakenedCompanion(store, "u-refund");
  const imp = await store.createChatImport("u-refund", comp.id, importOpts());
  (store as any).accountForDiscordUser = async () => ({ id: "a", plan: "free", creditBalance: 99 });
  const calls: string[] = [];
  const flakyBrain = {
    async distillHistoryWindow() {
      calls.push("x");
      if (calls.length === 2) throw new Error("provider hiccup");
      return {
        entries: [{ kind: "moment" as const, content: `unique window ${calls.length} content`, importance: 0.5 }],
        summary: `sum ${calls.length}`,
      };
    },
  };
  let spends = 0, refunds = 0;
  (store as any).spendCredits = async () => { spends++; return { ok: true, balance: 99 }; };
  (store as any).refundCredits = async () => { refunds++; return { ok: true, balance: 99 }; };
  await assert.rejects(
    runChatImportJob("dm:u-refund", { importId: imp.id },
      { ...jobDeps(store, flakyBrain), isHostedScope: () => true }),
    /hiccup/,
  );
  assert.equal(spends, 2);
  assert.equal(refunds, 1, "the failed window's credit is refunded like an unsent turn");
});

test("job — resumes mid-import from processed_turns + rolling summary", async () => {
  const { store } = await freshStore();
  const comp = await awakenedCompanion(store, "u-resume");
  const imp = await store.createChatImport("u-resume", comp.id, importOpts());
  // Simulate a crashed run: claimed, first window done, summary carried.
  await store.claimChatImport(imp.id);
  await store.updateChatImportProgress(imp.id, 30, 1, "first window survived");

  const calls: string[] = [];
  await runChatImportJob("dm:u-resume", { importId: imp.id }, jobDeps(store, fakeBrain(calls)));

  assert.equal(calls.length, 2); // windows 2+3 only
  assert.ok(calls[0].includes("turn 30")); // resumed at the right offset
  const cur = await store.chatImportById(imp.id);
  assert.equal(cur?.status, "done");
  assert.equal(cur?.processedTurns, 65);
});

test("job — missing companion or empty turns fail cleanly", async () => {
  const { store } = await freshStore();
  const comp = await awakenedCompanion(store, "u-missing");
  const imp = await store.createChatImport("u-missing", comp.id, importOpts());
  await sql`DELETE FROM companions WHERE id = ${comp.id}`; // companion gone after queueing
  await runChatImportJob("dm:u-missing", { importId: imp.id }, jobDeps(store, fakeBrain()));
  // ON DELETE CASCADE — the import row dies with the companion (its memories
  // went with it); the job just drops stale rather than resurrecting.
  assert.equal(await store.chatImportById(imp.id), null);

  const comp2 = await awakenedCompanion(store, "u-empty");
  const empty = await store.createChatImport("u-empty", comp2.id, { ...importOpts(), turns: [] });
  await runChatImportJob("dm:u-empty", { importId: empty.id }, jobDeps(store, fakeBrain()));
  assert.equal((await store.chatImportById(empty.id))?.status, "failed");
});

test("job — terminal failure marks the import failed and retracts journal", async () => {
  const { store } = await freshStore();
  const comp = await awakenedCompanion(store, "u-term");
  const imp = await store.createChatImport("u-term", comp.id, importOpts());
  const deadBrain = { async distillHistoryWindow() { throw new Error("provider down"); } };

  // attempts=MAX → the catch marks it failed before rethrowing for dead-letter.
  await assert.rejects(
    runChatImportJob("dm:u-term", { importId: imp.id }, jobDeps(store, deadBrain), 5),
  );
  const cur = await store.chatImportById(imp.id);
  assert.equal(cur?.status, "failed");
  assert.equal(cur?.turns.length, 0);
});

test("job — a FatalJobError fails the import row, not just the job", async () => {
  const { store } = await freshStore();
  const comp = await awakenedCompanion(store, "u-fatal");
  const imp = await store.createChatImport("u-fatal", comp.id, importOpts());
  const fatalBrain = { async distillHistoryWindow() { throw new FatalJobError("poison payload"); } };

  // Fatal means the worker dead-letters immediately — attempts are irrelevant.
  // Before the fix the row stayed 'distilling' forever: a permanently-
  // spinning import on the dashboard.
  await assert.rejects(
    runChatImportJob("dm:u-fatal", { importId: imp.id }, jobDeps(store, fatalBrain)),
    /poison payload/,
  );
  const cur = await store.chatImportById(imp.id);
  assert.equal(cur?.status, "failed");
  assert.match(cur?.error ?? "", /poison payload/);
  assert.equal(cur?.turns.length, 0);
});

test("job — imported entries carry the owner as subject (opt-out + about-sort coverage)", async () => {
  const { store } = await freshStore();
  const comp = await awakenedCompanion(store, "u-subj");
  const imp = await store.createChatImport("u-subj", comp.id, importOpts());
  await runChatImportJob("dm:u-subj", { importId: imp.id }, jobDeps(store, fakeBrain()));

  const about = await store.journalAboutSubject("dm:u-subj", "u-subj");
  assert.equal(about.length, 4); // 3 windows + bond — the owner is on every one

  // forgetJournalAbout is what opt-out calls on the dm scope — imported
  // entries must die with the rest of the owner's derived data.
  const deleted = await store.forgetJournalAbout("dm:u-subj", "u-subj");
  assert.equal(deleted, 4);
  assert.equal((await store.journalAboutSubject("dm:u-subj", "u-subj")).length, 0);
});

test("listChatImports + deleteChatImport — manager view, owner guard, journal cascade", async () => {
  const { store } = await freshStore();
  const compA = await awakenedCompanion(store, "u-own", "Nyx");
  const compB = await awakenedCompanion(store, "u-other", "Kestrel");
  const a = await store.createChatImport("u-own", compA.id, importOpts("a.jsonl"));
  await store.createChatImport("u-other", compB.id, importOpts("b.jsonl"));

  const list = await store.listChatImports("u-own");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, a.id);
  assert.equal(list[0].companionName, "Nyx");

  // Not theirs — no delete, no leak.
  assert.equal(await store.deleteChatImport("u-other", a.id), null);
  assert.ok(await store.chatImportById(a.id));

  // Theirs — row gone and every memory it wrote retracted by the FK cascade.
  await store.saveImportedJournalEntries(
    compA.id, "dm:u-own",
    [{ kind: "moment", content: "a carried-over memory about to be undone", importance: 0.6, aboutSubjects: ["u-own"] }],
    a.id, "2024-05-02T00:00:00Z", async () => true,
  );
  const removed = await store.deleteChatImport("u-own", a.id);
  assert.equal(removed?.id, a.id);
  assert.equal(await store.chatImportById(a.id), null);
  const journal = await sql<[{ c: number | string }]>`
    SELECT COUNT(*) AS c FROM companion_journal WHERE import_id = ${a.id}`;
  assert.equal(Number(journal[0].c), 0);
});
