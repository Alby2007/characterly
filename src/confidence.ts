import type { EvidenceType } from "./types.js";

/**
 * Deterministic confidence calculation based on evidence type.
 * This ensures the same evidence type always produces the same initial confidence,
 * removing any ambiguity or LLM-dependent variations.
 */
export function calculateInitialConfidence(evidenceType: EvidenceType): number {
  const confidenceMap: Record<EvidenceType, number> = {
    explicit_fact: 0.60,
    clear_preference: 0.60,
    direct_observation: 0.45,
    reported_by_other: 0.35,
    correction: 0.80,
    sarcasm_or_joke: 0.10,
    uncertain_inference: 0.20,
    // In-fiction evidence asserts a story beat, not a real-world claim — it
    // starts as reliable as a direct statement within its fiction. The
    // promotable-types allowlist still excludes it from real-world promotion.
    in_fiction: 0.60,
  };
  return confidenceMap[evidenceType] ?? 0.20;
}

/**
 * Update confidence based on evidence effect.
 * Uses a deterministic formula that doesn't depend on LLM output.
 * 
 * Support: Increases confidence using a bounded formula that approaches 0.95
 * Contradict: Halves confidence — note the evidence pipeline never applies
 *   this directly: a contradict effect freezes confidence and marks the memory
 *   contested instead (net_score arbitrates). This branch exists for direct
 *   callers/tests that model the raw effect.
 * Correct: No confidence change (handled by supersession logic)
 * Context: No confidence change
 */
export function updateConfidence(currentConfidence: number, effect: "support" | "contradict" | "correct" | "context"): number {
  switch (effect) {
    case "support":
      return Math.min(0.95, currentConfidence + 0.05 * (1 - currentConfidence));
    case "contradict":
      return currentConfidence * 0.5;
    case "correct":
    case "context":
      return currentConfidence;
    default:
      return currentConfidence;
  }
}

/**
 * Calculate default importance for a memory kind.
 * Used when LLM doesn't provide importance (now that LLM doesn't set numeric values).
 */
export function calculateDefaultImportance(kind: "person_fact" | "person_preference" | "server_lore" | "episode" | "story_fact"): number {
  const importanceMap: Record<typeof kind, number> = {
    person_fact: 0.5,
    person_preference: 0.6,
    server_lore: 0.7,
    episode: 0.4,
    // Plot beats matter within their story but must not outrank real facts
    // in any shared ranking — mid-band, below person knowledge.
    story_fact: 0.45,
  };
  return importanceMap[kind];
}

/**
 * Calculate default explicitness for an evidence type.
 * Used when LLM doesn't provide explicitness (now that LLM doesn't set numeric values).
 */
export function calculateDefaultExplicitness(evidenceType: EvidenceType): number {
  const explicitnessMap: Record<EvidenceType, number> = {
    explicit_fact: 0.9,
    clear_preference: 0.8,
    direct_observation: 0.6,
    reported_by_other: 0.4,
    correction: 0.95,
    sarcasm_or_joke: 0.2,
    uncertain_inference: 0.3,
    // Fiction narration is explicit about what happened in-scene.
    in_fiction: 0.7,
  };
  return explicitnessMap[evidenceType] ?? 0.5;
}