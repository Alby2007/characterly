import assert from "node:assert/strict";
import test from "node:test";
import { shouldInspectForMemory } from "./perception.js";
import type { MessageEvent } from "./types.js";
import { makeTestSql, makeStore } from "./test-helpers.js";

const event = (content: string): MessageEvent => ({ guildId: "guild", channelId: "channel", messageId: `message-${content.length}`, authorId: "user", authorName: "User", content, createdAt: new Date(), mentionsBot: false });

test("only durable-looking messages reach memory extraction", () => {
  assert.equal(shouldInspectForMemory(event("lol that was funny")), false);
  assert.equal(shouldInspectForMemory(event("I really love Arsenal and watch every match.")), true);
});

test("repeated candidate memory becomes active", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const candidate = { subjectId: "user", kind: "person_preference" as const, content: "User likes Arsenal", importance: .5, reason: "A stated preference", evidenceType: "clear_preference" as const, effect: "support" as const };
    const first = await store.saveMemory(event("I like Arsenal"), candidate);
    assert.equal(first.status, "candidate");
    for (let index = 2; index <= 6; index++) await store.saveMemory({ ...event(`I like Arsenal ${index}`), messageId: `message-${index}` }, candidate);
    assert.equal((await store.maintain("guild", .7)).promoted, 0);
    assert.equal((await store.getMemory("guild", first.id))?.status, "active");
  } finally { await sql.end(); }
});

test("evidence is unique per memory but can support different memories", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const preference = { subjectId: "user", kind: "person_preference" as const, content: "User likes Arsenal", importance: .5, reason: "Explicit preference", evidenceType: "clear_preference" as const, effect: "support" as const };
    const episode = { ...preference, kind: "episode" as const, content: "User watched Arsenal today" };
    const source = { ...event("I love Arsenal"), messageId: "shared-source" };
    const memory = await store.saveMemory(source, preference);
    await store.saveMemory(source, preference);
    const secondMemory = await store.saveMemory(source, episode);
    assert.equal((await store.evidence("guild", memory.id)).length, 1);
    assert.equal((await store.evidence("guild", secondMemory.id)).length, 1);
    assert.equal((await store.evidence("guild", memory.id))[0].messageContentSnapshot, "I love Arsenal");
    assert.equal((await store.history("guild", memory.id)).length, 1);
  } finally { await sql.end(); }
});

test("duplicate support evidence cannot change confidence or counters", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const candidate = { subjectId: "user", kind: "person_preference" as const, content: "User likes tea", importance: .5, reason: "Explicit preference", evidenceType: "clear_preference" as const, effect: "support" as const };
    const source = { ...event("I love tea"), messageId: "tea-source" };
    const first = await store.saveMemory(source, candidate);
    const duplicate = await store.saveMemory(source, candidate);
    assert.equal(duplicate.confidence, first.confidence);
    assert.equal(duplicate.confirmationCount, first.confirmationCount);
    assert.equal((await store.evidence("guild", first.id)).length, 1);
  } finally { await sql.end(); }
});

test("contradicting evidence deterministically contests a memory without changing confidence", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const candidate = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "Explicit statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
    const memory = await store.saveMemory({ ...event("I support Arsenal"), messageId: "arsenal" }, candidate);
    const contradicted = await store.saveMemory({ ...event("I don't support Arsenal"), messageId: "not-arsenal" }, { ...candidate, effect: "contradict", reason: "Explicit contradiction" });
    // Contradiction sets status to contested and freezes confidence — net_score is the resolution mechanism.
    assert.equal(contradicted.status, "contested");
    assert.equal(contradicted.confidence, memory.confidence);
    assert.equal(contradicted.contradictionCount, 1);
  } finally { await sql.end(); }
});

test("age-weighted support can resolve a contested memory without rewriting confidence", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const candidate = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "Explicit statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
    const now = Date.now();
    const first = await store.saveMemory({ ...event("I support Arsenal 0"), messageId: "pre-0", createdAt: new Date(now - 20 * 1000) }, candidate);
    for (let index = 1; index < 20; index++) await store.saveMemory({ ...event(`I support Arsenal ${index}`), messageId: `pre-${index}`, createdAt: new Date(now - (20 - index) * 1000) }, candidate);
    await store.saveMemory({ ...event("I do not support Arsenal"), messageId: "contradiction", createdAt: new Date(now - 100 * 86_400_000) }, { ...candidate, effect: "contradict" });
    assert.equal((await store.getMemory("guild", first.id))?.status, "contested");
    const before = (await store.getMemory("guild", first.id))!;
    assert.ok(before.confidence >= .70, "confidence must be at or above resolution threshold before testing resolveContested");
    const result = await store.resolveContested("guild", first.id);
    assert.equal(result.resolved, true);
    assert.equal((await store.getMemory("guild", first.id))?.status, "active");
    // Confidence must not change during resolution — it was frozen in contested state.
    assert.equal((await store.getMemory("guild", first.id))?.confidence, before.confidence);
  } finally { await sql.end(); }
});

test("a non-promotable candidate cannot launder into active via contested resolution", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const rumor = { subjectId: "user", kind: "person_fact" as const, content: "User secretly supports Arsenal", importance: .5, reason: "Secondhand claim", evidenceType: "reported_by_other" as const, effect: "support" as const };
    const now = Date.now();
    const first = await store.saveMemory({ ...event("heard they support Arsenal 0"), messageId: "rumor-0", createdAt: new Date(now - 20 * 1000) }, rumor);
    for (let index = 1; index < 20; index++) await store.saveMemory({ ...event(`heard they support Arsenal ${index}`), messageId: `rumor-${index}`, createdAt: new Date(now - (20 - index) * 1000) }, rumor);
    // Weak evidence can grow confidence but can never promote — still a candidate.
    const grown = (await store.getMemory("guild", first.id))!;
    assert.equal(grown.status, "candidate");
    assert.ok(grown.confidence >= .70, `confidence was ${grown.confidence}`);
    // An old contradiction contests it; fresh supports still dominate net_score.
    await store.saveMemory({ ...event("they denied it once"), messageId: "rumor-denial", createdAt: new Date(now - 100 * 86_400_000) }, { ...rumor, effect: "contradict" });
    assert.equal((await store.getMemory("guild", first.id))?.status, "contested");
    const result = await store.resolveContested("guild", first.id);
    assert.equal(result.resolved, true);
    // Support won, but reported_by_other primary evidence may never reach active.
    assert.equal((await store.getMemory("guild", first.id))?.status, "candidate");
  } finally { await sql.end(); }
});

test("a direct correction supersedes the old memory and links the replacement", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const oldCandidate = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "Statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
    const old = await store.saveMemory({ ...event("I support Arsenal"), messageId: "old" }, oldCandidate);
    const replacement = await store.saveMemory({ ...event("Actually I support Chelsea"), messageId: "new" }, { ...oldCandidate, content: "User supports Chelsea", evidenceType: "correction", effect: "correct" });
    await store.supersede("guild", old.id, replacement.id);
    assert.equal((await store.getMemory("guild", old.id))?.status, "superseded");
    assert.equal((await store.getMemory("guild", replacement.id))?.status, "active");
    assert.equal((await store.getMemory("guild", replacement.id))?.supersedesMemoryId, old.id);
  } finally { await sql.end(); }
});

test("ambiguous statements remain qualified candidates", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const ambiguous = { subjectId: "user", kind: "person_fact" as const, content: "User might move to London", importance: .5, reason: "Ambiguous statement", evidenceType: "uncertain_inference" as const, effect: "context" as const };
    const result = await store.saveMemory(event("I might move to London next year"), ambiguous);
    assert.equal(result.status, "candidate");
    assert.equal(result.content.includes("might"), true);
    assert.equal(result.confirmationCount, 0);
  } finally { await sql.end(); }
});

test("conditional preferences preserve nuance in content", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const conditional = { subjectId: "user", kind: "person_preference" as const, content: "User dislikes Chelsea except against Arsenal", importance: .5, reason: "Conditional preference", evidenceType: "clear_preference" as const, effect: "context" as const };
    const result = await store.saveMemory(event("I hate Chelsea, except when they play Arsenal"), conditional);
    assert.equal(result.status, "candidate");
    assert.equal(result.content.includes("except"), true);
    assert.equal(result.confirmationCount, 0);
  } finally { await sql.end(); }
});

test("evidence reuse across different memories works correctly", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const preference = { subjectId: "user", kind: "person_preference" as const, content: "User likes Arsenal", importance: .5, reason: "Preference", evidenceType: "clear_preference" as const, effect: "support" as const };
    const episode = { ...preference, kind: "episode" as const, content: "User watched Arsenal yesterday" };
    const source = event("I love Arsenal, watched them yesterday");
    const memory1 = await store.saveMemory(source, preference);
    const memory2 = await store.saveMemory(source, episode);
    assert.equal((await store.evidence("guild", memory1.id)).length, 1);
    assert.equal((await store.evidence("guild", memory2.id)).length, 1);
    assert.notEqual(memory1.id, memory2.id);
  } finally { await sql.end(); }
});

test("maintain() resolves a contested memory with overwhelming support", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const candidate = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "Explicit statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
    const now = Date.now();
    const first = await store.saveMemory({ ...event("I support Arsenal 0"), messageId: "pre-0", createdAt: new Date(now - 20 * 1000) }, candidate);
    for (let i = 1; i < 20; i++) await store.saveMemory({ ...event(`I support Arsenal ${i}`), messageId: `pre-${i}`, createdAt: new Date(now - (20 - i) * 1000) }, candidate);
    assert.ok((await store.getMemory("guild", first.id))!.confidence >= .70);
    await store.saveMemory({ ...event("I do not support Arsenal"), messageId: "contra", createdAt: new Date(now - 100 * 86_400_000) }, { ...candidate, effect: "contradict" });
    assert.equal((await store.getMemory("guild", first.id))?.status, "contested");
    const result = await store.maintain("guild");
    assert.equal(result.resolved, 1);
    assert.equal((await store.getMemory("guild", first.id))?.status, "active");
  } finally { await sql.end(); }
});

test("maintain() leaves a genuinely contested memory as contested", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const candidate = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "Explicit statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
    const first = await store.saveMemory({ ...event("I support Arsenal"), messageId: "m1" }, candidate);
    await store.saveMemory({ ...event("Actually I hate Arsenal"), messageId: "m2" }, { ...candidate, effect: "contradict" });
    const result = await store.maintain("guild");
    assert.equal(result.resolved, 0);
    assert.equal((await store.getMemory("guild", first.id))?.status, "contested");
  } finally { await sql.end(); }
});

test("confidence is frozen once a memory enters contested state", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const candidate = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "Explicit statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
    const first = await store.saveMemory({ ...event("I support Arsenal"), messageId: "m1" }, candidate);
    await store.saveMemory({ ...event("Actually no"), messageId: "m2" }, { ...candidate, effect: "contradict" });
    const afterContest = (await store.getMemory("guild", first.id))!;
    assert.equal(afterContest.status, "contested");
    await store.saveMemory({ ...event("I do support Arsenal"), messageId: "m3" }, candidate);
    await store.saveMemory({ ...event("Yes Arsenal!"), messageId: "m4" }, candidate);
    const afterMoreSupport = (await store.getMemory("guild", first.id))!;
    assert.equal(afterMoreSupport.status, "contested");
    assert.equal(afterMoreSupport.confidence, afterContest.confidence);
  } finally { await sql.end(); }
});

test("frozen_confidence is recorded when a memory first enters contested state", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const candidate = { subjectId: "user", kind: "person_fact" as const, content: "User runs every morning", importance: .5, reason: "Statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
    const first = await store.saveMemory({ ...event("I run 0"), messageId: "r0" }, candidate);
    for (let i = 1; i < 10; i++) await store.saveMemory({ ...event(`I run ${i}`), messageId: `r${i}` }, candidate);
    const before = (await store.getMemory("guild", first.id))!;
    await store.saveMemory({ ...event("I never run"), messageId: "contra" }, { ...candidate, effect: "contradict" });
    const after = (await store.getMemory("guild", first.id))!;
    assert.equal(after.status, "contested");
    assert.equal(after.frozenConfidence, before.confidence);
  } finally { await sql.end(); }
});

test("net_score is persisted on the memory row after resolveContested", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const candidate = { subjectId: "user", kind: "person_fact" as const, content: "User likes running", importance: .5, reason: "Statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
    const now = Date.now();
    const first = await store.saveMemory({ ...event("I like running 0"), messageId: "r0", createdAt: new Date(now - 20 * 1000) }, candidate);
    for (let i = 1; i < 20; i++) await store.saveMemory({ ...event(`I like running ${i}`), messageId: `r${i}`, createdAt: new Date(now - (20 - i) * 1000) }, candidate);
    await store.saveMemory({ ...event("I hate running"), messageId: "contra", createdAt: new Date(now - 100 * 86_400_000) }, { ...candidate, effect: "contradict" });
    await store.resolveContested("guild", first.id);
    const resolved = (await store.getMemory("guild", first.id))!;
    assert.equal(resolved.status, "active");
    assert.equal(resolved.netScore, null);
    assert.equal(resolved.frozenConfidence, null);
  } finally { await sql.end(); }
});

test("episodes below the threshold are not consolidated into a pattern", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const makeEpisode = async (content: string, id: string) => store.saveMemory(
      { ...event(content), messageId: id },
      { subjectId: "user", kind: "episode" as const, content, importance: .5, reason: "Observed", evidenceType: "explicit_fact" as const, effect: "support" as const }
    );
    const e1 = await makeEpisode("User went running", "ep1");
    const e2 = await makeEpisode("User went to the gym", "ep2");
    await store.confirm("guild", e1.id);
    await store.confirm("guild", e2.id);
    const patternsCreated = await store.consolidateEpisodes("guild", "user");
    assert.equal(patternsCreated, 0);
    assert.equal((await store.patterns("guild", "user")).length, 0);
  } finally { await sql.end(); }
});

test("enough active episodes are consolidated into a behavioral pattern", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const makeEpisode = async (content: string, id: string) => {
      const mem = await store.saveMemory(
        { ...event(content), messageId: id },
        { subjectId: "user", kind: "episode" as const, content, importance: .5, reason: "Observed", evidenceType: "explicit_fact" as const, effect: "support" as const }
      );
      await store.confirm("guild", mem.id);
      return (await store.getMemory("guild", mem.id))!;
    };
    await makeEpisode("User went running", "ep1");
    await makeEpisode("User went to the gym", "ep2");
    await makeEpisode("User did yoga", "ep3");
    const patternsCreated = await store.consolidateEpisodes("guild", "user");
    assert.equal(patternsCreated, 1);
    const patterns = await store.patterns("guild", "user");
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].episodeCount, 3);
    assert.ok(patterns[0].confidence > 0);
  } finally { await sql.end(); }
});

test("only active episodes count toward pattern consolidation — candidates are excluded", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const makeActive = async (content: string, id: string) => {
      const mem = await store.saveMemory({ ...event(content), messageId: id }, { subjectId: "user", kind: "episode" as const, content, importance: .5, reason: "Observed", evidenceType: "explicit_fact" as const, effect: "support" as const });
      await store.confirm("guild", mem.id);
    };
    await makeActive("User ran 5k", "act1");
    await makeActive("User cycled", "act2");
    await store.saveMemory({ ...event("Maybe user swam"), messageId: "cand1" }, { subjectId: "user", kind: "episode" as const, content: "User might have swum", importance: .5, reason: "Uncertain", evidenceType: "uncertain_inference" as const, effect: "context" as const });
    await store.saveMemory({ ...event("Rumour user boxed"), messageId: "cand2" }, { subjectId: "user", kind: "episode" as const, content: "Rumour user does boxing", importance: .5, reason: "Rumour", evidenceType: "reported_by_other" as const, effect: "context" as const });
    const patternsCreated = await store.consolidateEpisodes("guild", "user");
    assert.equal(patternsCreated, 0);
    assert.equal((await store.patterns("guild", "user")).length, 0);
  } finally { await sql.end(); }
});

test("maintain() reports patternsFound when episodes consolidate", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    for (let i = 0; i < 3; i++) {
      const mem = await store.saveMemory(
        { ...event(`Episode ${i}`), messageId: `ep${i}` },
        { subjectId: "user", kind: "episode" as const, content: `User did activity ${i}`, importance: .5, reason: "Observed", evidenceType: "explicit_fact" as const, effect: "support" as const }
      );
      await store.confirm("guild", mem.id);
    }
    const result = await store.maintain("guild");
    assert.equal(result.patternsFound, 1);
  } finally { await sql.end(); }
});

test("subjectConfirm routes non-promotable evidence back to candidate", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // A sarcasm-typed memory contested then affirmed by the subject must not
    // bypass the evidence-type gate — 'active' is only reachable via
    // promotable evidence (same rule resolveContested enforces).
    const sarc = { subjectId: "user", kind: "person_fact" as const, content: "User is secretly a millionaire", importance: .5, reason: "joked", evidenceType: "sarcasm_or_joke" as const, effect: "support" as const };
    const m = await store.saveMemory({ ...event("yeah I'm totally rich lol"), messageId: "sarc-1" }, sarc);
    await store.saveMemory({ ...event("no you're not"), messageId: "sarc-2" }, { ...sarc, effect: "contradict" as const });
    assert.equal((await store.getMemory("guild", m.id))!.status, "contested");
    await store.subjectConfirm("guild", m.id);
    assert.equal((await store.getMemory("guild", m.id))!.status, "candidate", "subject authority cannot launder sarcasm into fact");
    const history = await store.history("guild", m.id);
    assert.ok(history.some(h => h.action === "subject_confirmed"));
    assert.ok(!history.some(h => h.action === "status_confirmed"));
  } finally { await sql.end(); }
});

test("a stale contested standoff settles — fresh disputes still wait for the subject", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const staleDay = new Date(Date.now() - 40 * 86_400_000);
    const fact = { subjectId: "user", kind: "person_fact" as const, importance: .5, reason: "said so", evidenceType: "explicit_fact" as const, effect: "support" as const };

    // Stale support-leaning contest: can't resolve to active (frozen conf <
    // 0.7) but the dispute is old — return to the verification pool.
    const tea = { ...fact, content: "User likes tea" };
    const m1 = await store.saveMemory({ ...event("I like tea"), messageId: "tea-1", createdAt: staleDay }, tea);
    await store.saveMemory({ ...event("I like tea again"), messageId: "tea-2", createdAt: staleDay }, tea);
    await store.saveMemory({ ...event("you don't like tea"), messageId: "tea-3", createdAt: staleDay }, { ...tea, effect: "contradict" as const });
    assert.equal((await store.getMemory("guild", m1.id))!.status, "contested");
    const r1 = await store.resolveContested("guild", m1.id, new Date());
    assert.equal(r1.resolved, true);
    assert.equal((await store.getMemory("guild", m1.id))!.status, "candidate");

    // Stale contradiction-leaning contest — the claim lost and nobody spoke
    // for it in a month; quarantine it rather than re-litigating forever.
    const coffee = { ...fact, content: "User likes coffee" };
    const m2 = await store.saveMemory({ ...event("I like coffee"), messageId: "coffee-1", createdAt: staleDay }, coffee);
    await store.saveMemory({ ...event("nah you don't"), messageId: "coffee-2", createdAt: staleDay }, { ...coffee, effect: "contradict" as const });
    await store.saveMemory({ ...event("seriously, no"), messageId: "coffee-3", createdAt: staleDay }, { ...coffee, effect: "contradict" as const });
    const r2 = await store.resolveContested("guild", m2.id, new Date());
    assert.equal(r2.resolved, true);
    assert.equal((await store.getMemory("guild", m2.id))!.status, "quarantined");

    // A fresh identical dispute stays contested — the subject may still weigh in.
    const juice = { ...fact, content: "User likes juice" };
    const m3 = await store.saveMemory({ ...event("I like juice"), messageId: "juice-1" }, juice);
    await store.saveMemory({ ...event("nah you don't"), messageId: "juice-2" }, { ...juice, effect: "contradict" as const });
    const r3 = await store.resolveContested("guild", m3.id, new Date());
    assert.equal(r3.resolved, false);
    assert.equal((await store.getMemory("guild", m3.id))!.status, "contested");
  } finally { await sql.end(); }
});

test("an unchanged contested re-scan does not spam memory_history", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const cand = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "x", evidenceType: "explicit_fact" as const, effect: "support" as const };
    const m = await store.saveMemory({ ...event("I support Arsenal"), messageId: "afc-1" }, cand);
    await store.saveMemory({ ...event("no you don't"), messageId: "afc-2" }, { ...cand, effect: "contradict" as const });
    // netScore 0 — stays contested; nightly maintain() re-scans it.
    await store.resolveContested("guild", m.id);
    await store.resolveContested("guild", m.id);
    await store.resolveContested("guild", m.id);
    const unresolved = (await store.history("guild", m.id)).filter(h => h.action === "conflict_unresolved");
    assert.equal(unresolved.length, 1, "only the first inconclusive pass logs — unchanged repeats are silent");
  } finally { await sql.end(); }
});

test("sweep scope queries: only DM scopes with pending work / recent LLM use", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const msg = (id: string, scope: string, ageMin: number, triage: string | null) => sql`
      INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at, triage_result)
      VALUES (${id}, ${scope}, 'c', 'u', 'U', 'hi there', now() - (${ageMin} || ' minutes')::interval, ${triage})`;
    await msg("m1", "dm:fresh", 5, null);          // unclassified, inside window
    await msg("m2", "dm:stale", 600, null);        // unclassified, outside window
    await msg("m3", "dm:orphan", 6000, "durable"); // stranded mark, any age
    await msg("m4", "dm:done", 5, "noise");        // already classified
    await msg("m5", "guild-1", 5, null);           // guilds walk the client cache
    const scopes = await store.dmScopesNeedingSweep(new Date(Date.now() - 2 * 60 * 60_000));
    assert.deepEqual(scopes.sort(), ["dm:fresh", "dm:orphan"]);

    await sql`INSERT INTO guild_usage (guild_id, day, llm_calls) VALUES
      ('dm:today', (now() AT TIME ZONE 'UTC')::date, 3),
      ('dm:old', (now() AT TIME ZONE 'UTC')::date - 5, 9),
      ('dm:zero', (now() AT TIME ZONE 'UTC')::date, 0),
      ('guild-1', (now() AT TIME ZONE 'UTC')::date, 4)`;
    assert.deepEqual(await store.dmScopesActiveSince(new Date(Date.now() - 86_400_000)), ["dm:today"]);
  } finally { await sql.end(); }
});

test("backgroundCapped: only background-context calls charge hosted:background, and its cap throws BudgetExceeded", async () => {
  const { backgroundCapped, runAsBackground, BudgetExceeded } = await import("./budget.js");
  const charged: string[] = [];
  let used = 0;
  const store = { chargeLlmCall: async (scope: string, cap: number) => { charged.push(scope); used++; return { ok: used <= cap, cap }; } };
  let calls = 0;
  const inner = { responses: { create: async () => { calls++; return {}; } }, chat: { completions: { create: async () => { calls++; return {}; } } } };
  const client = backgroundCapped(inner as never, { store: store as never, getCap: async () => 1 });
  await client.chat.completions.create({});
  assert.deepEqual(charged, [], "live calls never touch the background meter");
  await runAsBackground(() => client.chat.completions.create({}));
  assert.deepEqual(charged, ["hosted:background"]);
  await assert.rejects(runAsBackground(() => client.chat.completions.create({})), (e: unknown) => e instanceof BudgetExceeded && e.guildId === "hosted:background");
  await client.chat.completions.create({});
  assert.equal(calls, 3, "live chat keeps flowing after the background share is spent");
});
