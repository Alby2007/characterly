/** Chat-history parsing + normalization — the transcript half of import.
 *  Pure TypeScript (Uint8Array, TextDecoder, crypto.subtle only) so the same
 *  file runs in the bot and in the website bundle. Handles the de-facto
 *  export shapes:
 *    - SillyTavern/Tavern `.jsonl` (CAI Tools "Download as Tavern chat") —
 *      first line is metadata, then one message object per line.
 *    - Oobabooga `.json` (CAI Tools "Download as Oobabooga chat") —
 *      `{internal|visible: [[user, char], …]}` pairs.
 *    - Generic message-array JSON — any `{messages|turns|history|…: [{…}]}`
 *      or top-level array of objects carrying a text field plus a speaker
 *      flag (covers CAI Tools history exports and most tooling). */

export const CHAT_MAX_BYTES = 8 * 1024 * 1024;
/** Hard caps on what distillation will see — a year of daily chat is ~2–4k
 *  turns, so 4000 is generous; per-turn text is capped because journal
 *  entries compress anyway. */
export const CHAT_MAX_TURNS = 4000;
export const CHAT_MAX_TURN_CHARS = 1500;

export interface ChatTurn {
  /** 'user' = the human's side, 'char' = the companion's side. Anything else
   *  is dropped during normalization, not stored. */
  speaker: "user" | "char";
  text: string;
  /** ISO timestamp when the export carried one; distillation backdates
   *  journal entries to the window's end so [age] reads honestly. */
  ts: string | null;
}

export interface ParsedChat {
  format: "jsonl" | "json";
  /** Best-guess display names — used in the distill prompt and provenance. */
  userName: string;
  charName: string;
  turns: ChatTurn[];
  /** Non-user/char speakers dropped (group chats, system notes). */
  droppedOthers: number;
  totalTurns: number;
  firstTs: string | null;
  lastTs: string | null;
}

export interface ChatImportMeta {
  source: string;
  format: string;
  userName: string;
  charName: string;
  totalTurns: number;
  droppedOthers: number;
  firstTs: string | null;
  lastTs: string | null;
  filename: string;
  sha256: string;
  importedAt: string;
  importedVia: string;
}

type ChatParseResult = { ok: true; chat: ParsedChat } | { ok: false; error: string };

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function parseTs(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000; // seconds vs ms — a 2001+ epoch in ms
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

const firstTsOf = (o: Record<string, unknown>): string | null => {
  for (const k of ["send_date", "created_at", "timestamp", "date", "ts", "time"]) {
    const t = parseTs(o[k]);
    if (t) return t;
  }
  return null;
};

/** Speaker classification — exports disagree on the flag name, so check the
 *  whole family. 'unknown' = a named speaker with no flags; the caller sorts
 *  those by name against its dominant-name guesses. */
function speakerOf(o: Record<string, unknown>, name: string): "user" | "char" | "other" | "unknown" {
  if (o.is_system === true || o.is_name === true) return "other";
  if (o.is_user === true || o.isUser === true) return "user";
  if (o.is_char === true || o.isChar === true) return "char";
  const role = str(o.role ?? o.author_role ?? o.type).toLowerCase();
  if (role === "user" || role === "human" || role === "you") return "user";
  if (role === "assistant" || role === "ai" || role === "model" || role === "char" || role === "character" || role === "bot") return "char";
  if (role === "system" || role === "narrator") return "other";
  // Flagless exports (c.ai dumps) lean on the name — resolved by the caller
  // against its dominant-name guesses.
  return name ? "unknown" : "other";
}

const textOf = (o: Record<string, unknown>): string =>
  str(o.mes ?? o.text ?? o.content ?? o.message ?? o.body ?? o.msg);

const nameOf = (o: Record<string, unknown>): string =>
  str(o.name ?? o.author ?? o.author_name ?? o.sender ?? o.display_name ?? o.username);

/** Turn a raw message-object array into normalized turns. The dominant
 *  non-user name wins 'char' — group-chat side characters fall to 'other'
 *  (dropped), so multi-bot exports don't blend two personas into one. */
function normalizeMessages(
  msgs: Record<string, unknown>[],
  hint: { userName?: string; charName?: string },
): { turns: ChatTurn[]; userName: string; charName: string; dropped: number } {
  // First pass: who talks most on each side? Character side = the most
  // frequent non-user, non-other name; user side = explicit flag or the
  // metadata hint, else the most frequent *user-flagged* name.
  const nonUserCounts = new Map<string, number>();
  const userCounts = new Map<string, number>();
  for (const m of msgs) {
    const name = nameOf(m);
    const sp = speakerOf(m, name);
    if (sp === "other") continue;
    if (sp === "user") userCounts.set(name, (userCounts.get(name) ?? 0) + 1);
    else if (name) nonUserCounts.set(name, (nonUserCounts.get(name) ?? 0) + 1);
  }
  const dominant = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  // The companion the user picked to receive this history is a strong
  // char-name hint when flags/metadata are silent — its name is known.
  const hintedChar = hint.charName && nonUserCounts.has(hint.charName) ? hint.charName : "";
  const charName = hintedChar || dominant(nonUserCounts) || hint.charName || "";
  const hintedUser = hint.userName && (userCounts.has(hint.userName) || nonUserCounts.has(hint.userName))
    ? hint.userName : "";
  const userName = hintedUser || dominant(userCounts);

  const turns: ChatTurn[] = [];
  let dropped = 0;
  for (const m of msgs) {
    const name = nameOf(m);
    let sp = speakerOf(m, name);
    if (sp === "unknown") {
      // No flag — sort by name against the resolved speakers.
      sp = userName && name === userName ? "user"
        : charName && name === charName ? "char"
        : "other";
    }
    const text = textOf(m);
    if (sp === "other" || !text) { dropped++; continue; }
    turns.push({ speaker: sp, text: cut(text, CHAT_MAX_TURN_CHARS), ts: firstTsOf(m) });
  }
  return { turns, userName, charName, dropped };
}

interface HintOpts { userName?: string; charName?: string }

/** Tavern .jsonl — first line is a metadata object (user_name /
 * character_name / chat_metadata), each later line is a message. */
function parseJsonl(text: string, opts: HintOpts): ChatParseResult | null {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const objs: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object" && !Array.isArray(o)) objs.push(o as Record<string, unknown>);
      else return null;
    } catch {
      return null; // any non-JSON line → this isn't jsonl
    }
  }
  const [meta, ...msgs] = objs;
  // The first line is metadata unless it already looks like a message.
  const firstIsMeta = !textOf(meta) && !speakerLooksMessage(meta);
  const messages = firstIsMeta ? msgs : objs;
  if (!messages.length || !messages.every(m => textOf(m))) return null;
  const metaObj = (meta.chat_metadata && typeof meta.chat_metadata === "object")
    ? meta.chat_metadata as Record<string, unknown>
    : {};
  const hint = {
    userName: str(meta.user_name ?? metaObj.user_name ?? meta.your_name) || opts.userName || "",
    charName: str(meta.character_name ?? metaObj.character_name ?? meta.char_name) || opts.charName || "",
  };
  const norm = normalizeMessages(messages, hint);
  if (!norm.turns.length) return { ok: false, error: "no_turns" };
  return { ok: true, chat: buildChat("jsonl", norm, messages.length) };
}

function speakerLooksMessage(o: Record<string, unknown>): boolean {
  return o.is_user !== undefined || o.is_char !== undefined || o.role !== undefined || o.mes !== undefined;
}

/** Oobabooga .json — {internal|visible: [[user_text, char_text], …]}. */
function parseOobabooga(raw: Record<string, unknown>, opts: HintOpts): ChatParseResult | null {
  const pairs = (raw.internal ?? raw.visible) as unknown;
  if (!Array.isArray(pairs) || !pairs.length || !pairs.every(p => Array.isArray(p) && p.length >= 2)) return null;
  const turns: ChatTurn[] = [];
  for (const [u, c] of pairs as unknown[][]) {
    if (str(u)) turns.push({ speaker: "user", text: cut(str(u), CHAT_MAX_TURN_CHARS), ts: null });
    if (str(c)) turns.push({ speaker: "char", text: cut(str(c), CHAT_MAX_TURN_CHARS), ts: null });
  }
  const meta = (raw.metadata && typeof raw.metadata === "object") ? raw.metadata as Record<string, unknown> : {};
  if (!turns.length) return { ok: false, error: "no_turns" };
  return {
    ok: true,
    chat: buildChat("json", {
      turns,
      userName: str(raw.name1 ?? meta.user_name ?? meta.name1) || opts.userName || "",
      charName: str(raw.name2 ?? meta.character_name ?? meta.name2) || opts.charName || "",
      dropped: 0,
    }, turns.length),
  };
}

/** Generic message-array shapes — `{messages|turns|history|chat|msgs: [...]}`
 *  or a bare top-level array of message objects. */
function parseGenericJson(raw: unknown, opts: HintOpts): ChatParseResult | null {
  let msgs: unknown = null;
  let container: Record<string, unknown> = {};
  if (Array.isArray(raw)) {
    msgs = raw;
  } else if (raw && typeof raw === "object") {
    container = raw as Record<string, unknown>;
    for (const k of ["messages", "turns", "history", "chat", "msgs", "conversation"]) {
      if (Array.isArray(container[k])) { msgs = container[k]; break; }
    }
  }
  if (!Array.isArray(msgs) || msgs.length < 4) return null;
  const objs = msgs.filter(m => m && typeof m === "object" && !Array.isArray(m)) as Record<string, unknown>[];
  if (objs.length < msgs.length * 0.8 || !objs.every(m => textOf(m))) return null;
  const hint = {
    userName: str(container.user_name ?? container.your_name ?? container.user) || opts.userName || "",
    charName: str(container.character_name ?? container.char_name ?? container.character ?? container.name) || opts.charName || "",
  };
  const norm = normalizeMessages(objs, hint);
  if (!norm.turns.length) return { ok: false, error: "no_turns" };
  return { ok: true, chat: buildChat("json", norm, msgs.length) };
}

function buildChat(
  format: ParsedChat["format"],
  norm: { turns: ChatTurn[]; userName: string; charName: string; dropped: number },
  total: number,
): ParsedChat {
  const turns = norm.turns.slice(0, CHAT_MAX_TURNS);
  const timed = turns.filter(t => t.ts);
  return {
    format,
    userName: norm.userName || "you",
    charName: norm.charName || "the character",
    turns,
    droppedOthers: norm.dropped + Math.max(0, norm.turns.length - turns.length),
    totalTurns: total,
    firstTs: timed[0]?.ts ?? null,
    lastTs: timed[timed.length - 1]?.ts ?? null,
  };
}

/** Detect the export format and pull normalized turns out of it. Returns
 *  'not_a_chat' for anything that doesn't look like a transcript — the card
 *  importer sniffs this to route the file to the right flow. */
export function parseChatFile(bytes: Uint8Array, filename = "", opts: HintOpts = {}): ChatParseResult {
  if (bytes.length > CHAT_MAX_BYTES) return { ok: false, error: "too_large" };
  const text = new TextDecoder().decode(bytes).trim();
  if (!text) return { ok: false, error: "not_a_chat" };

  const isJsonlName = /\.jsonl$/i.test(filename) || /\.txt$/i.test(filename);
  if (isJsonlName || !text.startsWith("{")) {
    const r = parseJsonl(text, opts);
    if (r) return r;
    if (isJsonlName) return { ok: false, error: "bad_json" };
  }

  if (!text.startsWith("{") && !text.startsWith("[")) return { ok: false, error: "not_a_chat" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "bad_json" };
  }
  // A card (.json character card) is not a transcript — route elsewhere.
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (o.spec || o.first_mes || (o.data && typeof o.data === "object" && !Array.isArray(o.data) &&
        (o.data as Record<string, unknown>).first_mes !== undefined)) {
      return { ok: false, error: "not_a_chat" };
    }
    const ooba = parseOobabooga(o, opts);
    if (ooba) return ooba;
  }
  const generic = parseGenericJson(raw, opts);
  if (generic) return generic;
  return { ok: false, error: "not_a_chat" };
}

export async function chatFileHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function chatImportMeta(
  chat: ParsedChat,
  extra: { filename: string; sha256: string; importedVia: "discord" | "web" },
): ChatImportMeta {
  return {
    source: "chat_history",
    format: chat.format,
    userName: cut(chat.userName, 120),
    charName: cut(chat.charName, 120),
    totalTurns: chat.totalTurns,
    droppedOthers: chat.droppedOthers,
    firstTs: chat.firstTs,
    lastTs: chat.lastTs,
    filename: cut(extra.filename, 200),
    sha256: cut(extra.sha256, 80),
    importedAt: new Date().toISOString(),
    importedVia: extra.importedVia,
  };
}
