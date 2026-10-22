import { test } from "node:test";
import assert from "node:assert/strict";
import { matchLore, normalizeLoreEntries, LORE_MATCH_MAX_ENTRIES, LORE_MATCH_MAX_CHARS, LORE_SCAN_CHARS } from "./lorebook.js";
import type { LoreEntry } from "./types.js";

// ── matchLore — the per-turn keyword matcher ─────────────────────────────────

test("matchLore: a constant entry fires even on an empty scan", () => {
  const entries: LoreEntry[] = [{ keys: [], content: "always on", constant: true }];
  assert.deepEqual(matchLore(entries, ""), entries);
});

test("matchLore: substring hit, case-insensitive by default", () => {
  const entries: LoreEntry[] = [{ keys: ["Spire"], content: "the laws of the Spire" }];
  assert.deepEqual(matchLore(entries, "we climbed the spire at dusk"), entries);
});

test("matchLore: no key hit → no entry", () => {
  const entries: LoreEntry[] = [
    { keys: ["dragon"], content: "dragons are extinct" },
    { keys: ["spire"], content: "the spire stands" },
  ];
  assert.deepEqual(matchLore(entries, "we climbed the spire"), [entries[1]]);
});

test("matchLore: caseSensitive entries only hit exact case", () => {
  const entries: LoreEntry[] = [{ keys: ["Kael"], content: "the sword-saint", caseSensitive: true }];
  assert.deepEqual(matchLore(entries, "kael smiled"), []);
  assert.deepEqual(matchLore(entries, "Kael smiled"), entries);
});

test("matchLore: wholeWords anchors to boundaries — and multi-word keys keep internal spaces", () => {
  const entries: LoreEntry[] = [
    { keys: ["art"], content: "art gallery", wholeWords: true },
    { keys: ["the veil"], content: "veil canon", wholeWords: true },
  ];
  // "art" inside "started"/"artist" must not hit.
  assert.deepEqual(matchLore(entries, "we started early"), []);
  assert.deepEqual(matchLore(entries, "the artist arrived"), []);
  assert.deepEqual(matchLore(entries, "an art opening"), [entries[0]]);
  // Multi-word: internal space is literal — "theveil" and "the  veil" differ.
  assert.deepEqual(matchLore(entries, "beyond the veil"), [entries[1]]);
  assert.deepEqual(matchLore(entries, "theveil"), []);
});

test("matchLore: selective entries need a secondaryKeys hit on top of a primary", () => {
  const entries: LoreEntry[] = [
    { keys: ["veil"], secondaryKeys: ["thin", "torn"], selective: true, content: "the veil is tearing" },
  ];
  assert.deepEqual(matchLore(entries, "the veil exists"), [], "primary alone isn't enough");
  assert.deepEqual(matchLore(entries, "something thin"), [], "secondary alone isn't enough");
  assert.deepEqual(matchLore(entries, "the veil runs thin here"), entries, "both → fires");
  // Non-selective twin ignores secondaries entirely.
  const plain: LoreEntry[] = [{ keys: ["veil"], secondaryKeys: ["thin"], content: "plain" }];
  assert.deepEqual(matchLore(plain, "the veil exists"), plain);
});

test("matchLore: enabled:false entries never fire", () => {
  const entries: LoreEntry[] = [
    { keys: ["spire"], content: "live" },
    { keys: ["spire"], content: "shelved", enabled: false },
    { keys: [], content: "shelved const", enabled: false, constant: true },
  ];
  assert.deepEqual(matchLore(entries, "the spire"), [entries[0]]);
});

test("matchLore: `order` sorts hits — unordered entries fire last", () => {
  const entries: LoreEntry[] = [
    { keys: ["a"], content: "unordered" },
    { keys: ["a"], content: "first", order: 1 },
    { keys: ["a"], content: "second", order: 2 },
  ];
  assert.deepEqual(
    matchLore(entries, "a a a").map(e => e.content),
    ["first", "second", "unordered"],
  );
});

test("matchLore: entry-count and char caps bound the injected block", () => {
  const many: LoreEntry[] = Array.from({ length: LORE_MATCH_MAX_ENTRIES + 3 }, (_, i) => ({
    keys: ["hit"], content: `entry ${i}`, order: i,
  }));
  const capped = matchLore(many, "hit");
  assert.equal(capped.length, LORE_MATCH_MAX_ENTRIES, "count cap");
  // Char cap: a huge first entry starves the rest.
  const fat: LoreEntry[] = [
    { keys: ["hit"], content: "x".repeat(LORE_MATCH_MAX_CHARS), order: 1 },
    { keys: ["hit"], content: "never fits", order: 2 },
  ];
  assert.deepEqual(matchLore(fat, "hit").map(e => e.content.length), [LORE_MATCH_MAX_CHARS]);
  // A just-over entry is skipped, not truncated — the next one that fits fires.
  const over: LoreEntry[] = [
    { keys: ["hit"], content: "x".repeat(LORE_MATCH_MAX_CHARS + 1), order: 1 },
    { keys: ["hit"], content: "fits", order: 2 },
  ];
  assert.deepEqual(matchLore(over, "hit").map(e => e.content), ["fits"]);
});

test("matchLore: the scan window is the tail — old matches scroll out", () => {
  const entries: LoreEntry[] = [{ keys: ["ancient"], content: "canon" }];
  const old = `ancient ${"x".repeat(LORE_SCAN_CHARS + 10)}`;
  assert.deepEqual(matchLore(entries, old), [], "key beyond the scan tail can't fire");
  const recent = `${"x".repeat(50)} ancient`;
  assert.deepEqual(matchLore(entries, recent), entries);
});

// ── normalizeLoreEntries — the storage-side normalizer ───────────────────────

test("normalizeLoreEntries: caps keys, content, comment — drops the dead", () => {
  const out = normalizeLoreEntries([
    { keys: ["a".repeat(100), "  ", "b"], content: "x".repeat(2000), comment: "c".repeat(200) },
    { keys: [], content: "no trigger" },                       // dead — drops
    { keys: ["k"], content: "   " },                            // dead — drops
    "not an object",                                            // dead — drops
    { keys: "single", content: "string key coerces" },          // string → [str]
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].keys, ["a".repeat(64), "b"]);
  assert.equal(out[0].content.length, 1200);
  assert.equal(out[0].comment!.length, 120);
  assert.deepEqual(out[1].keys, ["single"]);
});

test("normalizeLoreEntries: selective requires secondaryKeys; stray shapes tolerated", () => {
  const out = normalizeLoreEntries([
    { keys: ["v"], selective: true, content: "selective with no secondaries" },   // selective drops
    { keys: ["v"], selective: true, secondaryKeys: ["s"], content: "proper selective" },
    { keys: ["v"], secondaryKeys: "one", content: "secondary string coerces" },
    { keys: ["v"], constant: true, caseSensitive: true, wholeWords: true, enabled: false, order: 3, content: "flags keep" },
  ]);
  assert.equal(out.length, 4);
  assert.equal(out[0].selective, undefined, "selective without secondaries is meaningless — stripped");
  assert.equal(out[1].selective, true);
  assert.deepEqual(out[2].secondaryKeys, ["one"]);
  assert.equal(out[3].constant, true);
  assert.equal(out[3].caseSensitive, true);
  assert.equal(out[3].wholeWords, true);
  assert.equal(out[3].enabled, false);
  assert.equal(out[3].order, 3);
});

test("normalizeLoreEntries: filter-then-cap — blanks never eat slots", () => {
  const raw = [
    { keys: [], content: "dead" },
    ...Array.from({ length: 30 }, (_, i) => ({ keys: ["k"], content: `e${i}` })),
  ];
  const out = normalizeLoreEntries(raw);
  assert.equal(out.length, 25, "the dead entry doesn't consume a slot");
  assert.equal(out[0].content, "e0");
});

test("normalizeLoreEntries: non-array input normalizes to empty", () => {
  assert.deepEqual(normalizeLoreEntries(undefined), []);
  assert.deepEqual(normalizeLoreEntries("lore"), []);
  assert.deepEqual(normalizeLoreEntries({ keys: ["a"], content: "b" }), []);
});
