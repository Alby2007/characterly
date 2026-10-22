/** Character card (.json / .png) parsing + normalization.
 *  Pure TypeScript — Uint8Array, TextDecoder, atob, crypto.subtle only, so the
 *  same file runs in the bot and in the website bundle. Handles the de-facto
 *  ecosystem formats: chara_card_v2 (`{spec, spec_version, data}`), ccv3,
 *  flat v1 cards, and common exporter key aliases (CAI Tools etc.). */

import { LISTING_MAX_OPENINGS, LISTING_OPENING_MAX_CHARS } from "./types.js";
import type { LoreEntry } from "./types.js";
import { normalizeLoreEntries } from "./lorebook.js";

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
  lorebook: LoreEntry[];
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
  /** Card `alternate_greetings`, kept as pickable openings on the listing —
   *  the primary greeting above stays the default. */
  openings: { text: string }[];
  /** Card `character_book` entries — the listing's authored world canon,
   *  keyword-triggered into replies at turn time. */
  lore: LoreEntry[];
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

/** Extract every embedded character payload from a card PNG. Card v2 stores
 *  the payload as base64 in a `tEXt` chunk under the `chara` keyword; v3 uses
 *  `ccv3`. Some tools write an uncompressed `iTXt` instead — supported; zTXt
 *  (compressed) is rare and intentionally skipped. A PNG can carry several
 *  candidate chunks (a corrupt `chara` next to a valid `ccv3` happens), so we
 *  return all of them and let the caller try each until one parses. */
function cardJsonCandidatesFromPng(bytes: Uint8Array): string[] {
  const dec = new TextDecoder();
  const out: string[] = [];
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
        let text: string | null = null;
        if (type === "tEXt") {
          text = ascii(bytes, nul + 1, dataEnd - nul - 1);
        } else {
          // iTXt: keyword\0 compFlag compMethod lang\0 translated\0 utf8text
          let p = nul + 1;
          const compressed = bytes[p] === 1;
          p += 2;
          while (p < dataEnd && bytes[p] !== 0) p++; // language tag
          p++;
          while (p < dataEnd && bytes[p] !== 0) p++; // translated keyword
          p++;
          if (!compressed && p <= dataEnd) text = dec.decode(bytes.subarray(p, dataEnd));
        }
        if (text) out.push(text);
      }
    }
    off = dataOff + len + 4;
  }
  return out;
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

/** Raw card `character_book`/`embedded_lorebook` → normalized LoreEntry[]. The
 *  spec wraps entries in `book.entries` (array; some exporters emit an
 *  id-keyed object — world_info style). Field names follow chara_card_v2/v3;
 *  `insertion_order`/`priority` collapse into `order`, `extensions.
 *  match_whole_words` surfaces as `wholeWords`. Position/depth/probability/
 *  scan/budget semantics are intentionally dropped — see lorebook.ts. */
function cardLorebook(raw: unknown): LoreEntry[] {
  const book = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
  const entries = book?.entries;
  const list = Array.isArray(entries)
    ? entries
    : entries && typeof entries === "object"
      ? Object.values(entries)
      : [];
  const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v != null ? [v] : []);
  const out: LoreEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    const content = str(e.content);
    if (!content) continue;
    const keys = strArr(asList(e.keys)).map(k => k.slice(0, 64));
    const secondaryKeys = strArr(asList(e.secondary_keys)).map(k => k.slice(0, 64));
    const constant = e.constant === true;
    if (!constant && !keys.length) continue;
    const entry: LoreEntry = { keys, content };
    if (constant) entry.constant = true;
    if (secondaryKeys.length) entry.secondaryKeys = secondaryKeys;
    if (e.selective === true && secondaryKeys.length) entry.selective = true;
    if (e.case_sensitive === true) entry.caseSensitive = true;
    if (e.enabled === false) entry.enabled = false;
    const order = e.insertion_order ?? e.order ?? e.priority;
    if (typeof order === "number" && Number.isFinite(order)) entry.order = order;
    const comment = str(e.comment) || str(e.name);
    if (comment) entry.comment = comment.slice(0, 120);
    const ext = e.extensions && typeof e.extensions === "object" && !Array.isArray(e.extensions)
      ? e.extensions as Record<string, unknown> : null;
    if (ext?.match_whole_words === true) entry.wholeWords = true;
    out.push(entry);
  }
  return out;
}

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
    lorebook: cardLorebook(merged.character_book ?? merged.embedded_lorebook),
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
  const jsonTexts: string[] = [];
  if (isPng(bytes)) {
    for (const embedded of cardJsonCandidatesFromPng(bytes)) {
      const payload = b64ToU8(embedded);
      // tEXt payloads are base64; an uncompressed iTXt is already JSON.
      const text = payload ? new TextDecoder().decode(payload) : embedded.trimStart().startsWith("{") ? embedded : null;
      if (text) jsonTexts.push(text);
    }
    if (!jsonTexts.length) return { ok: false, error: "no_card_in_png" };
  } else {
    const head = bytes.length > JSON_MAX_BYTES ? "" : new TextDecoder().decode(bytes).trimStart();
    if (!head || !head.startsWith("{")) return { ok: false, error: "not_a_card" };
    jsonTexts.push(head);
  }
  let raw: unknown = null;
  let parsed = false;
  for (const text of jsonTexts) {
    try {
      raw = JSON.parse(text);
      parsed = true;
      break;
    } catch {
      // A corrupt `chara` chunk next to a valid `ccv3` (or vice versa) —
      // fall through to the next candidate.
    }
  }
  if (!parsed) return { ok: false, error: "bad_json" };
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
  // {{user}} reads differently by position: in persona prose it's third-person
  // ("the user"); in the greeting the character is speaking TO them → "you".
  const fill = (s: string, user = "the user") => s.replace(/\{\{char\}\}/gi, name).replace(/\{\{user\}\}/gi, user);
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

  const greeting = cut(fill(card.firstMes, "you"), 2000);
  // Alternate greetings become pickable openings at first meet. Cards often
  // repeat first_mes inside alternates — dedupe against the greeting and
  // each other (whitespace-normalized), cap by count then length.
  const seen = new Set([greeting.replace(/\s+/g, " ").trim().toLowerCase()]);
  const openings = card.alternateGreetings
    .map(g => cut(fill(g, "you"), LISTING_OPENING_MAX_CHARS))
    .filter(g => {
      const key = g.replace(/\s+/g, " ").trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, LISTING_MAX_OPENINGS)
    .map(text => ({ text }));

  // World-book entries keep their flags; {{char}}/{{user}} fill applies to
  // keys and content alike — a key "{{char}}'s mother" should still trigger.
  // normalizeLoreEntries enforces the storage caps so import, the modal
  // editor and the DB write path all agree.
  const lore = normalizeLoreEntries(card.lorebook.map(e => ({
    ...e,
    keys: e.keys.map(k => fill(k)),
    secondaryKeys: e.secondaryKeys?.map(k => fill(k)),
    content: fill(e.content),
    comment: e.comment ? fill(e.comment) : undefined,
  })));

  return {
    name,
    tagline: firstSentence(description || personality, 200) || "Imported character",
    voicePersona: cut(voice || description, 2000) || "A warm, distinct personality.",
    coreTraits: traits,
    ownerDynamic: "Companion",
    backstory: cut(backstory, 4000),
    greeting,
    openings,
    lore,
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
    // Card-controlled strings are bounded here — the same caps the web RPC
    // applies — so a huge `creator` field can't bloat the row or break the
    // 2,000-char mod-channel alert that prints it.
    spec: cut(card.spec || "unknown", 40),
    specVersion: cut(card.specVersion, 20),
    creator: cut(card.creator, 120),
    characterVersion: cut(card.characterVersion, 40),
    tags: card.tags.slice(0, 20).map(t => cut(t, 40)),
    filename: cut(extra.filename, 200),
    sha256: cut(extra.sha256, 80),
    importedAt: new Date().toISOString(),
    importedVia: extra.importedVia,
  };
}
