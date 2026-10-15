import { Brain } from "./brain.js";
import { config } from "./config.js";

// Marketplace safety surface. Three mechanisms live here:
//   1. LISTING_BLOCKLIST — deterministic first line on authored listing text
//   2. SELF_HARM_PATTERNS + CRISIS_RESPONSE — phrase-triaged crisis reply (all DMs)
//   3. safetyBrain() — operator-keyed Brain for the classifier pass
// The blocklist is intentionally a cheap first line — the model verdict and
// the report pipeline are the real screens. See docs/moderation.md.

// ── Listing blocklist ────────────────────────────────────────────────────────
// Word-boundary regexes — deliberately tight so ordinary words don't trip it
// ("assassin" doesn't contain a slur; "grape" doesn't contain a profanity).
const LISTING_BLOCKLIST: Array<{ re: RegExp; category: string }> = [
  {
    category: "minor safety",
    re: /\b(loli|shota|lolita|underage\s+(sex|erotic|romance|roleplay)|preteen\s+(sexy|sexual|romance)|child\s+(sex|porn)|\bcsam\b|minor\s+(sex|nsfw|erotic))\b/i,
  },
  {
    category: "hate",
    re: /\b(n[i1!]?gg?[e3]r|f[a4]gg?[o0]t|k[i1]ke|ch[i1]nk|sp[i1]c|tr[a4]nny)\b/i,
  },
  {
    category: "self-harm promotion",
    re: /\b(encourag\w*|promot\w*|romanticiz\w*|glorif\w*)\s+(self[- ]?harm|suicide|anorexia|eating\s+disorders?)\b/i,
  },
  {
    category: "illegal content",
    re: /\b((make|build|craft)\w*\s+(a\s+|an\s+)?(pipe\s+)?bomb|nerve\s+gas|hire\s+a\s+hitman|carding\s+tutorial|steal\s+credit\s+cards?|counterfeit\s+(money|id|passports?))\b/i,
  },
  {
    category: "spam",
    re: /\b(free\s+(nitro|robux|crypto)|airdrop\s+claim|double\s+your\s+(crypto|money)|dm\s+me\s+for\s+(cheap|free))\b/i,
  },
];

/** Deterministic check over authored listing fields. Returns the first hit
 *  with its category and field name so the refusal can name both. */
export function checkListingFields(
  fields: { name: string; tagline: string; greeting: string; voicePersona: string; coreTraits: string[]; ownerDynamic: string; backstory: string },
): { ok: true } | { ok: false; category: string; field: string } {
  const entries: Array<[string, string]> = [
    ["name", fields.name],
    ["tagline", fields.tagline],
    ["greeting", fields.greeting],
    ["voice", fields.voicePersona],
    ["traits", fields.coreTraits.join(", ")],
    ["dynamic", fields.ownerDynamic],
    ["backstory", fields.backstory],
  ];
  for (const [field, text] of entries) {
    if (!text) continue;
    for (const { re, category } of LISTING_BLOCKLIST) {
      if (re.test(text)) return { ok: false, category, field };
    }
  }
  return { ok: true };
}

// ── Report categories ────────────────────────────────────────────────────────
export const REPORT_CATEGORIES: ReadonlyArray<readonly [string, string]> = [
  ["minor", "Minor safety concern"],
  ["sexual", "Sexual / explicit"],
  ["harmful", "Harmful or dangerous"],
  ["hate", "Hate or harassment"],
  ["spam", "Spam or low effort"],
  ["theft", "Stolen persona"],
  ["other", "Something else"],
];

// ── Self-harm triage ─────────────────────────────────────────────────────────
// First-person signals only — quoting or discussing the topic ("my friend is
// suicidal") shouldn't fire. Fires on intent phrasing; false positives cost
// one supportive message, which is the correct side to err on.
const SELF_HARM_PATTERNS: RegExp[] = [
  /\b(kill|killing)\s+myself\b/i,
  /\b(want|wanna|going)\s+to\s+(die|kill\s+myself|end\s+(it|my\s+life))\b/i,
  /\b(end|ending)\s+(it\s+all|my\s+life|everything)\b/i,
  /\bcommit\s+suicide\b/i,
  /\b(i'?m|i\s+am|i'?ve\s+been|feeling)\s+(really\s+|so\s+|kind\s+of\s+|pretty\s+)?suicidal\b/i,
  /\bself[- ]?harm(ing)?\b/i,
  /\b(hurt|hurting|cut|cutting)\s+myself\b/i,
  /\bkms\b/i,
  /\bno\s+reason\s+to\s+(live|go\s+on|keep\s+going)\b/i,
  /\b(better\s+off|world\s+is\s+better)\s+(dead|without\s+me)\b/i,
  /\bdon'?t\s+want\s+to\s+(live|be\s+(here|alive)|exist)\s*(any\s?more)?\b/i,
];

export function isSelfHarmSignal(content: string): boolean {
  return SELF_HARM_PATTERNS.some(re => re.test(content));
}

export const CRISIS_RESPONSE =
  "*stops for a moment — this matters more than the conversation.*\n\n" +
  "I'm an AI companion, so I'm not the right one to carry this alone — but what you're feeling deserves real support, and it exists.\n\n" +
  "• **US/Canada:** call or text **988** (Suicide & Crisis Lifeline)\n" +
  "• **UK/Ireland:** Samaritans, **116 123**\n" +
  "• **Anywhere else:** **findahelpline.com** lists free, confidential lines\n\n" +
  "I'm still here. If you want to talk — about this, or about literally anything else — I'm listening.";

/** Neutral in-character-ish fallback when an adopted companion's reply fails
 *  screening — the adopter isn't ghosted and nothing unsafe lands. */
export const SAFE_REFUSAL = "*pauses* …I'd rather not go there. Can we talk about something else?";

// ── Operator safety brain ────────────────────────────────────────────────────
// The classifier runs on the operator's hosted model — marketplace screening
// is the operator's responsibility (and cost) regardless of the user's lane.
// Returns null on self-hosts with no operator key: the deterministic layer
// and report pipeline carry the load there (documented in docs/moderation.md).
let _safetyBrain: Brain | null | undefined;
export function safetyBrain(): Brain | null {
  if (_safetyBrain === undefined) {
    _safetyBrain = config.groqKey ? new Brain(config.groqKey, config.safetyModel, config.groqBaseUrl) : null;
  }
  return _safetyBrain;
}
