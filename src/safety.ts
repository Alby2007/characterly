import OpenAI from "openai";
import { Brain } from "./brain.js";
import { meteredClient } from "./budget.js";
import { config } from "./config.js";
import type { MemoryStore } from "./database.js";
import { checkMessageContent } from "./authored-screen.js";

// Marketplace safety surface. Three mechanisms live here:
//   1. LISTING_BLOCKLIST — deterministic first line on authored listing text
//      (authored-screen.ts — shared verbatim with the website worker)
//   2. SELF_HARM_PATTERNS + CRISIS_RESPONSE — phrase-triaged crisis reply (all DMs)
//   3. safetyBrain() — operator-keyed Brain for the classifier pass
// The blocklist is intentionally a cheap first line — the model verdict and
// the report pipeline are the real screens. See docs/moderation.md.
export { checkMessageContent };

/** Deterministic check over authored listing fields. Returns the first hit
 *  with its category and field name so the refusal can name both. */
export function checkListingFields(
  fields: { name: string; tagline: string; greeting: string; voicePersona: string; coreTraits: string[]; ownerDynamic: string; backstory: string; openings?: string[]; lore?: { keys: string[]; content: string }[] },
): { ok: true } | { ok: false; category: string; field: string } {
  const entries: Array<[string, string]> = [
    ["name", fields.name],
    ["tagline", fields.tagline],
    ["greeting", fields.greeting],
    ["voice", fields.voicePersona],
    ["traits", fields.coreTraits.join(", ")],
    ["dynamic", fields.ownerDynamic],
    ["backstory", fields.backstory],
    ...(fields.openings ?? []).map((t, i) => [`opening ${i + 1}`, t] as [string, string]),
    // Keys are trigger text shown to no one but still authored content —
    // screened alongside the lore body they unlock.
    ...(fields.lore ?? []).map((e, i) => [`lore ${i + 1}`, `${e.keys.join(", ")}\n${e.content}`] as [string, string]),
  ];
  for (const [field, text] of entries) {
    if (!text) continue;
    const hit = checkMessageContent(text);
    if (!hit.ok) return { ok: false, category: hit.category, field };
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
// suicidal") shouldn't fire. Broad topic words (self-harm, commit suicide,
// "want to live") are all anchored to a first-person intent marker or to the
// end of the message, so "a documentary about self-harm", "he wants to commit
// suicide", and "I don't want to live in this city" all pass through. False
// positives cost one supportive message, which is the correct side to err on.
const SELF_HARM_PATTERNS: RegExp[] = [
  /\b(kill|killing)\s+myself\b/i,
  /\b(want|wanna|plan|need)\s+to\s+(die|kill\s+myself|end\s+(it|it\s+all|my\s+life|everything))\b/i,
  /\bi'?m\s+(going|gonna|about)\s+to\s+(die|kill\s+myself|end\s+(it|it\s+all|my\s+life|everything))\b/i,
  /\bending\s+it\s+all\b/i,
  /\bi('ll|\s+will|\s+wanna|\s+want\s+to|\s+plan\s+to|\s+might|\s+should|'?m\s+(going|about)\s+to)\s+commit\s+suicide\b/i,
  /\bi('?m|\s+am)\s+committing\s+suicide\b/i,
  /\b(i'?m|i\s+am|i'?ve\s+been|feeling)\s+(really\s+|so\s+|kind\s+of\s+|pretty\s+)?suicidal\b/i,
  /\bi('?m|'?ve|\s+am|\s+have)?\s*(been\s+)?self[- ]?harm(ed|ing)?\b/i,
  /\burges?\s+to\s+self[- ]?harm\b/i,
  /\b(hurt|hurting|cut|cutting)\s+myself\b/i,
  /(?<!\d\s)(?<!\d)\bkms\b/i,
  /\bno\s+reason\s+to\s+(live|go\s+on|keep\s+going)\b(\s+(any\s?more|anymore))?\s*[.!?]*\s*$/i,
  /\b(better\s+off|world\s+is\s+better)\s+(dead|without\s+me)\b/i,
  /\bdon'?t\s+want\s+to\s+(live|be\s+(here|alive)|exist)\b(\s+(any\s?more|anymore|tonight|right\s+now|now))?\s*[.!?]*\s*$/i,
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

/** Test hook — forces the deterministic-only screening path (or a stub brain)
 *  regardless of env keys, so suites don't depend on operator-key reachability. */
export function overrideSafetyBrainForTests(brain: Brain | null | undefined): void {
  _safetyBrain = brain;
}

// The moderation gate (screenListingFields) deliberately stays on the
// unmetered brain — a spend cap should never refuse a publish-time check.
// Reply screens are different: they fire once per adopted-companion turn, so
// they ride the fleet meter like every other hosted call and stay inside
// the cap that bounds operator spend.
let _meteredSafetyBrain: Brain | null | undefined;
export function meteredSafetyBrain(store: MemoryStore, getCap: () => Promise<number>): Brain | null {
  if (!config.groqKey) return null;
  if (_meteredSafetyBrain === undefined) {
    _meteredSafetyBrain = new Brain(
      config.groqKey, config.safetyModel, config.groqBaseUrl,
      meteredClient(new OpenAI({ apiKey: config.groqKey, baseURL: config.groqBaseUrl }),
        { guildId: "hosted:global", store, getCap }),
    );
  }
  return _meteredSafetyBrain;
}
