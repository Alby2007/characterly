import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SEED_LISTINGS } from "./seed-personas.js";
import { checkListingFields } from "./safety.js";
import { marketplaceAssetPath } from "./marketplace.js";

// The creator taxonomy seeded on the forum — seed tags must stay inside it.
const CREATOR_TAGS = new Set([
  "romance", "anime", "games", "fandom", "fantasy", "sci-fi", "horror", "oc",
  "rpg", "companion", "helpers", "comedy", "historical", "slice of life", "adventure",
].map(s => s.toLowerCase()));

test("seed roster: 15 unique-named personas", () => {
  assert.equal(SEED_LISTINGS.length, 15);
  assert.equal(new Set(SEED_LISTINGS.map(p => p.name.toLowerCase())).size, 15);
});

test("seed personas pass the listing blocklist and the modal length caps", () => {
  for (const p of SEED_LISTINGS) {
    const screen = checkListingFields(p);
    assert.ok(screen.ok, `${p.name} failed the blocklist: ${JSON.stringify(screen)}`);
    assert.ok(p.name.length <= 64, `${p.name} name too long`);
    assert.ok(p.tagline.length <= 120, `${p.name} tagline too long (${p.tagline.length})`);
    assert.ok(p.greeting.length <= 1000, `${p.name} greeting too long (${p.greeting.length})`);
    assert.ok(p.tagline && p.greeting && p.voicePersona, `${p.name} needs tagline/greeting/voice`);
  }
});

test("seed tags stay inside the creator taxonomy, ≤3 each", () => {
  for (const p of SEED_LISTINGS) {
    assert.ok(p.tags.length >= 1 && p.tags.length <= 3, `${p.name} has ${p.tags.length} tags`);
    for (const t of p.tags) {
      assert.ok(CREATOR_TAGS.has(t.toLowerCase()), `${p.name}: tag "${t}" isn't in the creator taxonomy`);
    }
  }
});

test("every seed coverFile resolves to a committed image asset", () => {
  for (const p of SEED_LISTINGS) {
    assert.ok(p.coverFile, `${p.name} needs a coverFile`);
    assert.ok(/\.(jpe?g|png|webp)$/i.test(p.coverFile), `${p.name}: ${p.coverFile} isn't an image ext`);
    // The helper resolves inside assets/marketplace/ — a miss means the art
    // was never committed and the listing would silently post coverless.
    assert.ok(marketplaceAssetPath(p.coverFile), `${p.name}: assets/marketplace/${p.coverFile} missing`);
    const size = fileURLToPath(new URL(`../assets/marketplace/${p.coverFile}`, import.meta.url));
    assert.ok(existsSync(size), `${p.name}: ${size} missing`);
  }
});
