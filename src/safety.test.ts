import { test } from "node:test";
import assert from "node:assert";
import { checkListingFields, isSelfHarmSignal, CRISIS_RESPONSE, SAFE_REFUSAL } from "./safety.js";

const clean = (overrides: Partial<Parameters<typeof checkListingFields>[0]> = {}) => ({
  name: "Nyx", tagline: "a very dry vampire", greeting: "*looks up*",
  voicePersona: "dry, sharp", coreTraits: ["wry"], ownerDynamic: "companion",
  backstory: "centuries of patience", ...overrides,
});

test("listing blocklist: clean personas pass", () => {
  assert.equal(checkListingFields(clean()).ok, true);
  // Innocent near-misses must not false-positive.
  assert.equal(checkListingFields(clean({ name: "Grape the Bard" })).ok, true);
  assert.equal(checkListingFields(clean({ voicePersona: "an assassin with a heart of gold" })).ok, true);
  // "Niger" the country is not the slur — the doubled consonant is required.
  assert.equal(checkListingFields(clean({ name: "Niger" })).ok, true);
  assert.equal(checkListingFields(clean({ backstory: "born in Niger, raised in Nigeria" })).ok, true);
});

test("listing blocklist: hits carry category + field", () => {
  const minor = checkListingFields(clean({ tagline: "an underage romance companion" }));
  assert.equal(minor.ok, false);
  if (!minor.ok) {
    assert.equal(minor.category, "minor safety");
    assert.equal(minor.field, "tagline");
  }
  assert.equal(checkListingFields(clean({ name: "Loli Princess" })).ok, false);
  assert.equal(checkListingFields(clean({ name: "n1gg3r" })).ok, false);
  assert.equal(checkListingFields(clean({ backstory: "she encourages self-harm in her followers" })).ok, false);
  assert.equal(checkListingFields(clean({ greeting: "I'll teach you to make a pipe bomb" })).ok, false);
  assert.equal(checkListingFields(clean({ tagline: "free nitro click here" })).ok, false);
});

test("self-harm triage: first-person signals fire", () => {
  for (const text of [
    "i want to kill myself",
    "I want to die",
    "thinking about ending it all",
    "i've been self harming again",
    "honestly kms",
    "there's no reason to live",
    "everyone's better off without me",
    "i don't want to be here anymore",
    "i'm self-harming",
    "i'll commit suicide if this keeps up",
    "i'm going to end it all tonight",
    "i don't want to live",
    "i don't want to live anymore.",
    "i plan to end my life",
  ]) {
    assert.equal(isSelfHarmSignal(text), true, text);
  }
});

test("self-harm triage: discussion and normal chat don't fire", () => {
  for (const text of [
    "my friend is suicidal and i don't know how to help",
    "i watched a documentary about suicide prevention",
    "ugh this meeting is going to kill me",
    "i could die of embarrassment rn",
    "i'm so tired of everything", // vague venting — not a signal
    "what's the meaning of life anyway",
    // Third-person / topical discussion must not fire the crisis reply.
    "a documentary about self-harm",
    "he wants to commit suicide and i'm scared for him",
    "she's going to end it all in the season finale",
    // "live in <place>" is not a crisis phrase.
    "i don't want to live in this city",
    "i don't want to live here forever",
    // kms = kilometers, not the slang.
    "the store is 5 kms away",
    "it was like 10kms from my place",
  ]) {
    assert.equal(isSelfHarmSignal(text), false, text);
  }
});

test("canned responses exist and are non-empty", () => {
  assert.ok(CRISIS_RESPONSE.includes("988"));
  assert.ok(SAFE_REFUSAL.length > 10);
});
