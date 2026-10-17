import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseChatFile, chatImportMeta, chatFileHash,
  CHAT_MAX_TURNS, CHAT_MAX_TURN_CHARS, CHAT_MAX_BYTES,
} from "./chathist.js";

const enc = (s: string) => new TextEncoder().encode(s);

const tavern = [
  JSON.stringify({ user_name: "Alby", character_name: "Nyx", chat_metadata: {} }),
  JSON.stringify({ name: "Alby", is_user: true, mes: "hey, you awake?", send_date: "2024-05-01T10:00:00Z" }),
  JSON.stringify({ name: "Nyx", is_user: false, mes: "*looks up* …you again.", send_date: "2024-05-01T10:01:00Z" }),
  JSON.stringify({ name: "Alby", is_user: true, mes: "always", send_date: "2024-05-01T10:02:00Z" }),
].join("\n");

test("tavern jsonl — metadata line skipped, turns + speakers + timestamps", () => {
  const r = parseChatFile(enc(tavern), "chat.jsonl");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.chat.format, "jsonl");
  assert.equal(r.chat.userName, "Alby");
  assert.equal(r.chat.charName, "Nyx");
  assert.equal(r.chat.turns.length, 3);
  assert.deepEqual(r.chat.turns.map(t => t.speaker), ["user", "char", "user"]);
  assert.equal(r.chat.turns[0].text, "hey, you awake?");
  assert.equal(r.chat.firstTs, "2024-05-01T10:00:00.000Z");
  assert.equal(r.chat.lastTs, "2024-05-01T10:02:00.000Z");
  assert.equal(r.chat.totalTurns, 3);
});

test("oobabooga json — internal/visible pairs split into turns", () => {
  const raw = {
    internal: [["hi there", "hello"], ["what's your name", "I'm Nyx"]],
    visible: [["hi there", "hello"]],
    metadata: { name1: "Alby", name2: "Nyx" },
  };
  const r = parseChatFile(enc(JSON.stringify(raw)), "chat.json");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.chat.format, "json");
  assert.equal(r.chat.userName, "Alby");
  assert.equal(r.chat.charName, "Nyx");
  assert.equal(r.chat.turns.length, 4);
  assert.deepEqual(r.chat.turns.map(t => t.speaker), ["user", "char", "user", "char"]);
  assert.equal(r.chat.firstTs, null);
});

test("generic messages array — role flags classify, others drop", () => {
  const raw = {
    character_name: "Nyx",
    messages: [
      { role: "system", content: "you are in a bar" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey you" },
      { role: "user", content: "drink?" },
      { role: "assistant", content: "always" },
    ],
  };
  const r = parseChatFile(enc(JSON.stringify(raw)), "export.json");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.chat.turns.length, 4);
  assert.equal(r.chat.droppedOthers, 1); // the system line
  assert.equal(r.chat.charName, "Nyx");
});

test("flagless export — dominant non-user name wins char, hint breaks ties", () => {
  const msgs = [
    { name: "Alby", mes: "hi" },
    { name: "Nyx", mes: "hello" },
    { name: "Alby", mes: "how are you" },
    { name: "Nyx", mes: "still here" },
    { name: "Lurker", mes: "can I join" },
  ];
  // No flags, no hints: user vs char is genuinely ambiguous — the parser
  // resolves only the dominant name (→ char) and drops what it can't sort.
  // The UI's companion picker re-parse supplies the hint that resolves both.
  const r = parseChatFile(enc(JSON.stringify({ messages: msgs })), "x.json");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.chat.turns.length < 4);
  assert.ok(r.chat.droppedOthers >= 1);

  // The companion pick is the tiebreak — Nyx declared as the char.
  const r2 = parseChatFile(enc(JSON.stringify({ messages: msgs })), "x.json", { charName: "Nyx", userName: "Alby" });
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.equal(r2.chat.charName, "Nyx");
  assert.equal(r2.chat.userName, "Alby");
  assert.deepEqual(r2.chat.turns.map(t => t.speaker), ["user", "char", "user", "char"]);
});

test("character card json routes elsewhere — not_a_chat", () => {
  const card = { spec: "chara_card_v2", data: { name: "Nyx", first_mes: "hi" } };
  const r = parseChatFile(enc(JSON.stringify(card)), "card.json");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "not_a_chat");
});

test("malformed input — bad_json vs not_a_chat", () => {
  assert.equal(parseChatFile(enc("{not json"), "x.json").ok, false);
  const r = parseChatFile(enc("{not json"), "x.json");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "bad_json");

  const r2 = parseChatFile(enc(""), "x.jsonl");
  assert.equal(r2.ok, false);
  if (r2.ok) return;
  assert.equal(r2.error, "not_a_chat");

  const r3 = parseChatFile(enc("<html><body>offline export</body></html>"), "chat.txt");
  assert.equal(r3.ok, false);
});

test("no usable turns — empty transcript rejected", () => {
  const raw = { messages: [{ role: "system", content: "only system lines" }] };
  const r = parseChatFile(enc(JSON.stringify(raw)), "x.json");
  assert.equal(r.ok, false); // fewer than 4 msgs → not_a_chat
  const r2 = parseChatFile(enc(JSON.stringify({ messages: [
    { role: "system", content: "a" }, { role: "system", content: "b" },
    { role: "system", content: "c" }, { role: "system", content: "d" },
  ] })), "x.json");
  assert.equal(r2.ok, false);
  if (r2.ok) return;
  assert.equal(r2.error, "no_turns");
});

test("bounds — turns capped at CHAT_MAX_TURNS, text at CHAT_MAX_TURN_CHARS, file at CHAT_MAX_BYTES", () => {
  const msgs = Array.from({ length: CHAT_MAX_TURNS + 50 }, (_, i) => ({
    name: i % 2 ? "Nyx" : "Alby", is_user: i % 2 === 0, mes: `turn ${i} ${"x".repeat(1600)}`,
  }));
  const r = parseChatFile(enc(JSON.stringify({ messages: msgs })), "big.json");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.chat.turns.length, CHAT_MAX_TURNS);
  assert.ok(r.chat.turns.every(t => t.text.length <= CHAT_MAX_TURN_CHARS));
  assert.equal(r.chat.totalTurns, msgs.length);
  assert.ok(r.chat.droppedOthers >= 50);

  const tooBig = parseChatFile(new Uint8Array(CHAT_MAX_BYTES + 1), "huge.json");
  assert.equal(tooBig.ok, false);
  if (tooBig.ok) return;
  assert.equal(tooBig.error, "too_large");
});

test("epoch timestamps — seconds vs ms both resolve", () => {
  const msgs = {
    messages: [
      { name: "Alby", is_user: true, mes: "a", send_date: 1714500000 },
      { name: "Nyx", mes: "b", send_date: 1714500060000 },
      { name: "Alby", is_user: true, mes: "c" },
      { name: "Nyx", mes: "d" },
    ],
  };
  const r = parseChatFile(enc(JSON.stringify(msgs)), "x.json");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.chat.turns[0].ts, "2024-04-30T18:00:00.000Z");
  assert.equal(r.chat.turns[1].ts, "2024-04-30T18:01:00.000Z");
  assert.equal(r.chat.turns[2].ts, null);
});

test("meta + hash — provenance fields stamped", async () => {
  const r = parseChatFile(enc(tavern), "chat.jsonl");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const sha = await chatFileHash(enc(tavern));
  assert.match(sha, /^[0-9a-f]{64}$/);
  const meta = chatImportMeta(r.chat, { filename: "chat.jsonl", sha256: sha, importedVia: "web" });
  assert.equal(meta.source, "chat_history");
  assert.equal(meta.format, "jsonl");
  assert.equal(meta.userName, "Alby");
  assert.equal(meta.charName, "Nyx");
  assert.equal(meta.totalTurns, 3);
  assert.equal(meta.sha256, sha);
  assert.equal(meta.importedVia, "web");
});
