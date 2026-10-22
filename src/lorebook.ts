/** Listing lorebook matching — pure functions, no I/O. At turn time the reply
 *  paths fetch the adopted listing's `lorebook` entries and run matchLore over
 *  the recent-conversation tail; matched contents inject as a labeled "World
 *  lore" block (brain.ts extraBlocks). Keys are literal trigger strings —
 *  never interpreted as regex — matched case-insensitively against message
 *  text by default. This is a deliberately small subset of the SillyTavern
 *  semantics: no probability, depth/position, recursion, or token budgets. */

import type { LoreEntry } from "./types.js";
import {
  LISTING_MAX_LORE_ENTRIES,
  LISTING_LORE_ENTRY_MAX_CHARS,
  LISTING_LORE_MAX_KEYS,
  LISTING_LORE_KEY_MAX_CHARS,
} from "./types.js";

/** How many entries can inject per turn and how large the block may grow —
 *  the prompt-side budget that stands in for card `token_budget`. */
export const LORE_MATCH_MAX_ENTRIES = 4;
export const LORE_MATCH_MAX_CHARS = 1500;
/** How much recent conversation the match scans — stands in for card
 *  `scan_depth`. The reply paths pass the recent-context tail + the current
 *  turn's recall text already joined. */
export const LORE_SCAN_CHARS = 1200;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does `key` appear in `text`? Default: case-insensitive substring.
 *  `wholeWords` anchors to word boundaries (multi-word keys keep internal
 *  spaces literal); `caseSensitive` flips to exact-case. Empty keys never hit. */
function keyHit(text: string, key: string, e: Pick<LoreEntry, "caseSensitive" | "wholeWords">): boolean {
  const k = key.trim();
  if (!k) return false;
  if (e.wholeWords) {
    const flags = e.caseSensitive ? "" : "i";
    return new RegExp(`\\b${escapeRe(k)}\\b`, flags).test(text);
  }
  return e.caseSensitive ? text.includes(k) : text.toLowerCase().includes(k.toLowerCase());
}

/** Normalize an entry array for storage — shared by the DB write path and
 *  card import so the same caps apply wherever entries enter. Filter-then-
 *  cap: entries with no content and no way to fire drop first, then the
 *  count cap applies (blanks never eat slots). */
export function normalizeLoreEntries(raw: unknown): LoreEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: LoreEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const content = String(o.content ?? "").trim().slice(0, LISTING_LORE_ENTRY_MAX_CHARS);
    const keys = (Array.isArray(o.keys) ? o.keys : typeof o.keys === "string" ? [o.keys] : [])
      .map(k => String(k).trim().slice(0, LISTING_LORE_KEY_MAX_CHARS))
      .filter(Boolean);
    const secondaryKeys = (Array.isArray(o.secondaryKeys) ? o.secondaryKeys
      : typeof o.secondaryKeys === "string" ? [o.secondaryKeys] : [])
      .map(k => String(k).trim().slice(0, LISTING_LORE_KEY_MAX_CHARS))
      .filter(Boolean);
    const constant = o.constant === true;
    // An entry that can never fire (no keys, no secondary, not constant) is
    // dead weight — drop it rather than store a row that does nothing.
    if (!content || (!constant && !keys.length)) continue;
    const entry: LoreEntry = { keys: keys.slice(0, LISTING_LORE_MAX_KEYS), content };
    if (constant) entry.constant = true;
    if (secondaryKeys.length) entry.secondaryKeys = secondaryKeys.slice(0, LISTING_LORE_MAX_KEYS);
    if (o.selective === true && secondaryKeys.length) entry.selective = true;
    if (o.caseSensitive === true) entry.caseSensitive = true;
    if (o.wholeWords === true) entry.wholeWords = true;
    if (o.enabled === false) entry.enabled = false;
    if (typeof o.order === "number" && Number.isFinite(o.order)) entry.order = o.order;
    const comment = String(o.comment ?? "").trim();
    if (comment) entry.comment = comment.slice(0, 120);
    out.push(entry);
    if (out.length >= LISTING_MAX_LORE_ENTRIES) break;
  }
  return out;
}

/** Entries whose canon the current conversation touches: constants always
 *  fire; keyed entries fire on any key hit; `selective` entries additionally
 *  require a secondaryKeys hit. Sorted by `order` (unordered last, stable),
 *  capped by count and total injected characters. `scanText` is the recent-
 *  context tail + current turn — callers bound it to ~LORE_SCAN_CHARS. */
export function matchLore(entries: LoreEntry[], scanText: string): LoreEntry[] {
  if (!entries.length) return [];
  const scan = scanText.length > LORE_SCAN_CHARS ? scanText.slice(-LORE_SCAN_CHARS) : scanText;
  const hits = entries.filter(e =>
    e.enabled !== false
    && (e.constant === true || e.keys.some(k => keyHit(scan, k, e)))
    && (!e.selective || (e.secondaryKeys ?? []).some(k => keyHit(scan, k, e)))
  );
  hits.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  const out: LoreEntry[] = [];
  let chars = 0;
  for (const e of hits) {
    if (out.length >= LORE_MATCH_MAX_ENTRIES || chars + e.content.length > LORE_MATCH_MAX_CHARS) continue;
    out.push(e);
    chars += e.content.length;
  }
  return out;
}
