import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCardFile, cardToPersona, cardFileHash, cardImportMeta } from "./charcard.js";

const enc = new TextEncoder();

/** Minimal PNG writer for tests: signature + IHDR + tEXt(keyword) chunks +
 *  IEND. The parser doesn't validate CRCs, so zero-fill is fine. */
function cardPngChunks(texts: [string, string][]): Uint8Array {
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length + 4);
    new DataView(out.buffer).setUint32(0, body.length);
    out.set(enc.encode(type), 4);
    out.set(body, 8);
    return out;
  };
  const textChunks = texts.map(([kw, data]) =>
    chunk("tEXt", new Uint8Array([...enc.encode(kw), 0, ...enc.encode(data)])));
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunk("IHDR", new Uint8Array(13));
  const iend = chunk("IEND", new Uint8Array(0));
  const parts = [sig, ihdr, ...textChunks, iend];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
const cardPng = (payloadB64: string, keyword = "chara") => cardPngChunks([[keyword, payloadB64]]);

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const V2 = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Lirael",
    description: "A librarian who talks to the dead. Loves dusty archives.",
    personality: "curious, soft-spoken, brave",
    scenario: "The Old Kingdom, after dusk",
    first_mes: "*she looks up from her book* Oh — you're alive. Good.",
    mes_example: "<START>\n{{user}}: hi\n{{char}}: shh, the dead are listening",
    alternate_greetings: ["*a bell rings softly*"],
    tags: ["fantasy", "necromancer"],
    creator: "some-author",
    creator_notes: "port of my c.ai girl",
    character_version: "1.2",
  },
};

test("v2 JSON card parses and normalizes", () => {
  const res = parseCardFile(enc.encode(JSON.stringify(V2)), "lirael.json");
  assert.ok(res.ok);
  assert.equal(res.card.name, "Lirael");
  assert.equal(res.card.spec, "chara_card_v2");
  assert.equal(res.card.creator, "some-author");
  assert.deepEqual(res.card.tags, ["fantasy", "necromancer"]);
  assert.deepEqual(res.card.alternateGreetings, ["*a bell rings softly*"]);
});

test("PNG card: tEXt chunk payload round-trips", () => {
  const png = cardPng(b64(JSON.stringify(V2)));
  const res = parseCardFile(png, "lirael.png");
  assert.ok(res.ok);
  assert.equal(res.card.name, "Lirael");
  assert.equal(res.card.firstMes, V2.data.first_mes);
});

test("a corrupt chara chunk doesn't hide a valid ccv3 chunk", () => {
  // First keyword hits a garbage payload — the parser must keep scanning
  // instead of returning the first matching keyword.
  const png = cardPngChunks([["chara", "!!!not-base64-or-json!!!"], ["ccv3", b64(JSON.stringify(V2))]]);
  const res = parseCardFile(png, "dual.png");
  assert.ok(res.ok);
  assert.equal(res.card.name, "Lirael");
});

test("flat v1 card + CAI Tools aliases", () => {
  const v1 = {
    name: "Mogget",
    description: "A cat who is not a cat",
    greeting: "Mrow.",
    example_dialogue: "x",
  };
  const res = parseCardFile(enc.encode(JSON.stringify(v1)), "mogget.json");
  assert.ok(res.ok);
  assert.equal(res.card.name, "Mogget");
  assert.equal(res.card.firstMes, "Mrow."); // greeting alias → firstMes
  assert.equal(res.card.mesExample, "x");   // example_dialogue alias → mesExample
});

test("rejects non-card inputs cleanly", () => {
  assert.equal(parseCardFile(enc.encode("hello"), "x.txt").ok, false);
  assert.equal(parseCardFile(enc.encode("[1,2]"), "x.json").ok, false);
  assert.deepEqual(parseCardFile(enc.encode("{"), "x.json"), { ok: false, error: "bad_json" });
  assert.equal(parseCardFile(enc.encode("{}"), "x.json").ok, false); // no name/persona at all
  const plainPng = cardPng("", "notchara"); // right shape, no chara chunk
  assert.deepEqual(parseCardFile(plainPng, "x.png"), { ok: false, error: "no_card_in_png" });
});

test("oversized files refused before parse", () => {
  const big = new Uint8Array(9 * 1024 * 1024);
  assert.deepEqual(parseCardFile(big, "big.png"), { ok: false, error: "too_large" });
});

test("cardToPersona maps and bounds fields", () => {
  const res = parseCardFile(enc.encode(JSON.stringify(V2)), "lirael.json");
  assert.ok(res.ok);
  const p = cardToPersona(res.card);
  assert.equal(p.name, "Lirael");
  assert.ok(p.tagline.length <= 200);
  assert.ok(p.backstory.includes("SCENARIO:"));
  assert.ok(p.voicePersona.includes("EXAMPLE DIALOGUE:"));
  assert.ok(!p.voicePersona.includes("{{char}}"), "placeholders resolved");
  assert.equal(p.ownerDynamic, "Companion");
  assert.ok(p.greeting.includes("alive"));
  assert.deepEqual(p.coreTraits, ["curious", "soft-spoken", "brave"]);
});

test("cardToPersona maps alternate_greetings to deduped openings", () => {
  const res = parseCardFile(enc.encode(JSON.stringify(V2)), "lirael.json");
  assert.ok(res.ok);
  const p = cardToPersona(res.card);
  assert.deepEqual(p.openings, [{ text: "*a bell rings softly*" }]);
});

test("openings fill {{user}} as 'you', dedupe against the greeting, and cap", () => {
  const card = {
    name: "N",
    description: "d",
    first_mes: "Hi {{user}}!",
    alternate_greetings: [
      "Hi {{user}}!",            // the greeting repeated — must dedupe out
      "  hi   {{user}}! ",       // same, whitespace-normalized — also dedupes
      "Hey {{user}}, {{char}} waves.",  // distinct — survives, both slots filled
      ...Array.from({ length: 10 }, (_, i) => `Opening number ${i} for {{user}}`),
    ],
  };
  const res = parseCardFile(enc.encode(JSON.stringify(card)), "n.json");
  assert.ok(res.ok);
  const p = cardToPersona(res.card);
  assert.equal(p.greeting, "Hi you!");
  // First two alternates collapse to the greeting; the wave survives, then
  // the numbered openings fill out the cap (greeting + 4 max).
  assert.equal(p.openings.length, 4);
  assert.equal(p.openings[0].text, "Hey you, N waves.");
  assert.ok(p.openings.every(o => !o.text.includes("{{")), "no placeholder survives");
  assert.ok(new Set(p.openings.map(o => o.text)).size === p.openings.length, "no dupes");
});

test("openings respect the per-opening length cap and drop blanks", () => {
  const card = {
    name: "N", description: "d", first_mes: "hi",
    alternate_greetings: ["x".repeat(3000), "", "   ", "short"],
  };
  const res = parseCardFile(enc.encode(JSON.stringify(card)), "n.json");
  assert.ok(res.ok);
  const p = cardToPersona(res.card);
  assert.equal(p.openings.length, 2, "blanks drop, over-long opening counts once");
  assert.ok(p.openings[0].text.length <= 1000);
  assert.equal(p.openings[1].text, "short");
});

test("cardToPersona truncates oversized card fields", () => {
  const huge = { name: "Big", description: "d".repeat(20_000), personality: "x".repeat(5_000) };
  const res = parseCardFile(enc.encode(JSON.stringify(huge)), "big.json");
  assert.ok(res.ok);
  const p = cardToPersona(res.card);
  assert.ok(p.backstory.length <= 4000);
  assert.ok(p.voicePersona.length <= 2000);
});

test("{{user}} reads as 'you' in the greeting, 'the user' in persona prose", () => {
  const card = { name: "N", description: "d", personality: "protects {{user}}", first_mes: "Hi {{user}}!" };
  const res = parseCardFile(enc.encode(JSON.stringify(card)), "n.json");
  assert.ok(res.ok);
  const p = cardToPersona(res.card);
  assert.equal(p.greeting, "Hi you!");
  assert.ok(p.voicePersona.includes("the user"));
});

test("cardImportMeta bounds card-controlled strings", async () => {
  const card = { name: "N", description: "d", creator: "x".repeat(500), tags: Array(30).fill("t".repeat(60)) };
  const res = parseCardFile(enc.encode(JSON.stringify(card)), "n.json");
  assert.ok(res.ok);
  const meta = cardImportMeta(res.card, { filename: "f".repeat(300), sha256: "s".repeat(200), importedVia: "discord" });
  assert.ok(meta.creator.length <= 120);
  assert.ok(meta.filename.length <= 200);
  assert.ok(meta.sha256.length <= 80);
  assert.equal(meta.tags.length, 20);
  assert.ok(meta.tags[0].length <= 40);
});

test("sha256 hash is deterministic and meta stamps provenance", async () => {
  const bytes = enc.encode(JSON.stringify(V2));
  const h1 = await cardFileHash(bytes);
  const h2 = await cardFileHash(bytes);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  const res = parseCardFile(bytes, "lirael.json");
  assert.ok(res.ok);
  const meta = cardImportMeta(res.card, { filename: "lirael.json", sha256: h1, importedVia: "web" });
  assert.equal(meta.source, "character_card");
  assert.equal(meta.creator, "some-author");
  assert.equal(meta.importedVia, "web");
  assert.equal(meta.sha256, h1);
});
