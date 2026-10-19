import type { PairContext, PairContextEdge } from "./types.js";
import { promptInline, promptName } from "./prompt-safety.js";

// Prompt rendering for the reply path — shared by brain.reply()'s prompt
// sections and the internal lookup tools (lookup-tools.ts), so a person or a
// pair reads identically whether it was pre-fetched or fetched on demand.
// Every member/derived string is sanitized here so both consumers get the
// same prompt-hygiene guarantees (prompt-safety.ts).

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function monthYear(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/** Relative age bucket for prompt annotations — "~2w ago" gives the model
 * temporal grounding an ISO date never does: it can hedge fresh disclosures
 * differently from old history. Returns "" for unparseable input. */
export function formatAge(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `~${days}d ago`;
  if (days < 60) return `~${Math.round(days / 7)}w ago`;
  if (days < 365) return `~${Math.round(days / 30)}mo ago`;
  return `~${Math.round(days / 365)}y ago`;
}

/** Render one pair's relationship context as a single prompt line. Direction
 * is preserved explicitly — "A says about B" means A is the asserting side.
 * Claims are attributed ("B claimed about A"), never stated as facts. Depth
 * renders as a confidence tier, gossip-only edges are flagged "all
 * secondhand", stale edges say so, and behavior-only pairs surface strictly
 * as contact frequency — never phrased as a relationship claim. */
export function formatPairContext(ctx: PairContext): string {
  const aName = promptName(ctx.aName, "a member");
  const bName = promptName(ctx.bName, "a member");
  const tier = (n: number) => n >= 5 ? "well-established" : n >= 2 ? "described a few times" : "claimed once";
  const edge = (name: string, e: PairContextEdge, other: string) => {
    if (e.inferred || !e.summary) return null; // behavior-only — rendered via behavioralCount below
    let s = `${name} says about ${other}: "${promptInline(e.summary)}" (${e.valence != null ? e.valence.toFixed(2) : "no valence"}, ${tier(e.observationCount)})`;
    if (e.partyCount === 0) s += " — all secondhand";
    if (e.trend) s += `, lately ${promptInline(e.trend, 80)}`;
    if (e.lastObservedAt && Date.now() - new Date(e.lastObservedAt).getTime() > 60 * 86_400_000) {
      s += " (not recently observed)";
    }
    return s;
  };
  const parts: string[] = [];
  const aEdge = ctx.aToB ? edge(aName, ctx.aToB, bName) : null;
  const bEdge = ctx.bToA ? edge(bName, ctx.bToA, aName) : null;
  if (aEdge) parts.push(aEdge);
  if (bEdge) parts.push(bEdge);
  if (ctx.behavioralCount >= 5) {
    parts.push(aEdge || bEdge
      ? `also interact frequently (${ctx.behavioralCount} times in 90d)`
      : `frequent interaction (${ctx.behavioralCount} times in 90d) — dynamic not recorded`);
  }
  const reasons = ctx.reasons.map(r => `${promptName(r.fromName, "a member")}: "${promptInline(r.reason)}" (${shortDate(r.at)})`).join("; ");
  if (reasons) parts.push(`recent: ${reasons}`);
  if (ctx.claimsAboutA.length) parts.push(`${bName} claimed about ${aName}: ${ctx.claimsAboutA.map(c => `"${promptInline(c)}"`).join(", ")}`);
  if (ctx.claimsAboutB.length) parts.push(`${aName} claimed about ${bName}: ${ctx.claimsAboutB.map(c => `"${promptInline(c)}"`).join(", ")}`);
  if (ctx.sharedEvents.length) parts.push(`shared events: ${ctx.sharedEvents.map(e => promptInline(e, 120)).join(", ")}`);
  return `- ${aName} ↔ ${bName}: ${parts.join(". ")}`;
}

const ATTR_PLURALS: Record<string, string> = { trait: "traits", interest: "interests", skill: "skills" };
const confLabel = (c: number) => c >= 0.8 ? "high" : c >= 0.55 ? "medium" : "low";

export type ReplyProfile = {
  name: string; summary: string; traits?: string[];
  attributes?: Array<{ field: string; value: string; confidence: number }>;
};

/** One person's line in the People section. Structured attributes render with
 * field labels + confidence buckets so the model can hedge weak facets;
 * legacy flat traits are the fallback for profiles with no attribute rows. */
export function formatReplyProfile(p: ReplyProfile): string {
  const attrs = p.attributes ?? [];
  const base = `- ${promptName(p.name, "someone")}${p.summary ? `: ${promptInline(p.summary)}` : ""}`;
  if (!attrs.length) return `${base}${p.traits?.length ? ` (traits: ${p.traits.map(t => promptInline(t, 60)).join(", ")})` : ""}`;
  const byField = new Map<string, Array<{ value: string; confidence: number }>>();
  for (const a of attrs) {
    const field = promptInline(a.field, 40) || "note";
    const list = byField.get(field);
    if (list) list.push(a); else byField.set(field, [a]);
  }
  const fields = [...byField.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([field, list]) => {
    const items = [...list].sort((x, y) => y.confidence - x.confidence).map(a => `${promptInline(a.value, 120)} (${confLabel(a.confidence)})`).join(", ");
    return `${list.length > 1 ? (ATTR_PLURALS[field] ?? field) : field}: ${items}`;
  });
  return `${base} — ${fields.join("; ")}`;
}
