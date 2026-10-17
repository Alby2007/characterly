/** Character card (.json / .png) parsing + normalization.
 *  Pure TypeScript — Uint8Array, TextDecoder, atob, crypto.subtle only, so the
 *  same file runs in the bot and in the website bundle. Handles the de-facto
 *  ecosystem formats: chara_card_v2 (`{spec, spec_version, data}`), ccv3,
 *  flat v1 cards, and common exporter key aliases (CAI Tools etc.). */

export const CARD_MAX_BYTES = 8 * 1024 * 1024;
const JSON_MAX_BYTES = 256 * 1024;

export interface ParsedCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  alternateGreetings: string[];
  tags: string[];
  creator: string;
  creatorNotes: string;
  characterVersion: string;
  spec: string;
  specVersion: string;
}

export interface ImportPersona {
  name: string;
  tagline: string;
  voicePersona: string;
  coreTraits: string[];
  ownerDynamic: string;
  backstory: string;
  greeting: string;
}

export interface CardImportMeta {
  source: string;
  spec: string;
  specVersion: string;
  creator: string;
  characterVersion: string;
  tags: string[];
  filename: string;
  sha256: string;
  importedAt: string;
  importedVia: string;
}

type ParseResult = { ok: true; card: ParsedCard } | { ok: false; error: string };

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isPng = (b: Uint8Array) => b.length > 8 && PNG_MAGIC.every((v, i) => b[i] === v);

function readU32(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

function ascii(b: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]);
  return s;
}

/** Extract the embedded character JSON from a card PNG. Card v2 stores the
 *  payload as base64 in a `tEXt` chunk under the `chara` keyword; v3 uses
 *  `ccv3`. Some tools write an uncompressed `iTXt` instead — supported; zTXt
 *  (compressed) is rare and intentionally skipped. */
function cardJsonFromPng(bytes: Uint8Array): string | null {
  const dec = new TextDecoder();
  let off = 8;
  while (off + 12 <= bytes.length) {
    const len = readU32(bytes, off);
    const type = ascii(bytes, off + 4, 4);
    const dataOff = off + 8;
    if (len > bytes.length - dataOff - 4) break; // truncated chunk
    if (type === "tEXt" || type === "iTXt") {
      const dataEnd = dataOff + len;
      let nul = dataOff;
      while (nul < dataEnd && bytes[nul] !== 0) nul++;
      const keyword = ascii(bytes, dataOff, nul - dataOff).toLowerCase();
      if (keyword === "chara" || keyword === "ccv3") {
        if (type === "tEXt") {
          return ascii(bytes, nul + 1, dataEnd - nul - 1);
        }
        // iTXt: keyword\0 compFlag compMethod lang\0 translated\0 utf8text
        let p = nul + 1;
        const compressed = bytes[p] === 1;
        p += 2;
        while (p < dataEnd && bytes[p] !== 0) p++; // language tag
        p++;
        while (p < dataEnd && bytes[p] !== 0) p++; // translated keyword
        p++;
        if (!compressed && p <= dataEnd) return dec.decode(bytes.subarray(p, dataEnd));
      }
    }
    off = dataOff + len + 4;
  }
  return null;
}

function b64ToU8(s: string): Uint8Array | null {
  try {
    const clean = s.replace(/\s+/g, "");
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => str(x)).filter(Boolean) : [];

const firstField = (o: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return "";
};

function normalizeCard(raw: unknown): ParsedCard | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const outer = raw as Record<string, unknown>;
  // v2/v3 wrap fields in `data`; flat cards carry them at the top level.
  const inner = outer.data && typeof outer.data === "object" && !Array.isArray(outer.data)
    ? (outer.data as Record<string, unknown>)
    : outer;
  const merged = { ...outer, ...inner };
  const card: ParsedCard = {
    name: firstField(merged, ["name", "char_name"]),
    description: firstField(merged, ["description", "definition", "char_definition"]),
    personality: firstField(merged, ["personality", "persona"]),
    scenario: firstField(merged, ["scenario", "world_scenario"]),
    firstMes: firstField(merged, ["first_mes", "greeting", "first_message", "firstMessage"]),
    mesExample: firstField(merged, ["mes_example", "example_dialogue", "example_messages"]),
    alternateGreetings: strArr(merged.alternate_greetings ?? merged.alt_greetings),
    tags: strArr(merged.tags).slice(0, 20),
    creator: firstField(merged, ["creator", "author", "creator_name"]),
    creatorNotes: firstField(merged, ["creator_notes", "comment", "creator_comment"]),
    characterVersion: firstField(merged, ["character_version"]),
    spec: str(outer.spec) || str(merged.spec),
    specVersion: str(outer.spec_version) || str(merged.spec_version),
  };
  // A card with neither a name nor any persona text isn't importable.
  if (!card.name && !card.description && !card.personality) return null;
  return card;
}

/** Detect the file type and pull a normalized card out of it. `.png` is
 *  scanned for the embedded `chara`/`ccv3` chunk; anything else is treated
 *  as JSON (covers .json exports and pasted card text). */
export function parseCardFile(bytes: Uint8Array, filename = ""): ParseResult {
  if (bytes.length > CARD_MAX_BYTES) return { ok: false, error: "too_large" };
  let jsonText: string | null = null;
  if (isPng(bytes)) {
    const embedded = cardJsonFromPng(bytes);
    if (!embedded) return { ok: false, error: "no_card_in_png" };
    const payload = b64ToU8(embedded);
    // tEXt payloads are base64; an uncompressed iTXt is already JSON.
    jsonText = payload ? new TextDecoder().decode(payload) : embedded.trimStart().startsWith("{") ? embedded : null;
    if (!jsonText) return { ok: false, error: "no_card_in_png" };
  } else {
    const head = bytes.length > JSON_MAX_BYTES ? "" : new TextDecoder().decode(bytes).trimStart();
    if (!head || !head.startsWith("{")) return { ok: false, error: "not_a_card" };
    jsonText = head;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "bad_json" };
  }
  const card = normalizeCard(raw);
  return card ? { ok: true, card } : { ok: false, error: "not_a_card" };
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function firstSentence(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  const end = t.search(/[.!?](\s|$)/);
  return cut(end > 20 ? t.slice(0, end + 1) : t, n);
}

/** Card field → Characterly persona fields. Card decks run far longer than
 *  our conversational-onboarding sizes, so import caps are intentionally
 *  larger than the Discord modal limits — the columns are TEXT; the caps
 *  exist to bound prompt size, not to match the UI. `{{char}}`/`{{user}}`
 *  placeholders are resolved to the card name / a generic "the user". */
export function cardToPersona(card: ParsedCard): ImportPersona {
  const name = cut(card.name, 64) || "Imported Companion";
  const fill = (s: string) => s.replace(/\{\{char\}\}/gi, name).replace(/\{\{user\}\}/gi, "the user");
  const personality = fill(card.personality);
  const description = fill(card.description);
  const scenario = fill(card.scenario);
  const mesExample = fill(card.mesExample);

  let voice = personality;
  if (mesExample) voice += `${voice ? "\n\n" : ""}EXAMPLE DIALOGUE:\n${mesExample}`;
  let backstory = description;
  if (scenario) backstory += `${backstory ? "\n\n" : ""}SCENARIO:\n${scenario}`;

  const traits = (personality || description)
    .split(/[,;•|\n]+/)
    .map(t => t.trim().replace(/^["']|["']$/g, ""))
    .filter(t => t.length >= 2 && t.length <= 48 && !t.includes(":"))
    .slice(0, 8)
    .map(t => cut(t, 48));

  return {
    name,
    tagline: firstSentence(description || personality, 200) || "Imported character",
    voicePersona: cut(voice || description, 2000) || "A warm, distinct personality.",
    coreTraits: traits,
    ownerDynamic: "Companion",
    backstory: cut(backstory, 4000),
    greeting: cut(fill(card.firstMes), 2000),
  };
}

export async function cardFileHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function cardImportMeta(
  card: ParsedCard,
  extra: { filename: string; sha256: string; importedVia: "discord" | "web" },
): CardImportMeta {
  return {
    source: "character_card",
    spec: card.spec || "unknown",
    specVersion: card.specVersion,
    creator: card.creator,
    characterVersion: card.characterVersion,
    tags: card.tags,
    filename: extra.filename,
    sha256: extra.sha256,
    importedAt: new Date().toISOString(),
    importedVia: extra.importedVia,
  };
}
