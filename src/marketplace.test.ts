import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListingCard, marketplaceAssetPath, CURATED_TAGS } from "./marketplace.js";
import type { CompanionListing } from "./types.js";

const listing = (over: Partial<CompanionListing> = {}): CompanionListing => ({
  id: 1, creatorUserId: "u1", sourceCompanionId: null, name: "Test", tagline: "t",
  voicePersona: "v", coreTraits: [], ownerDynamic: "d", backstory: "b", greeting: "g",
  avatarUrl: null, version: 1, status: "active", addCount: 0, reportCount: 0, forumThreadId: null,
  personaSource: "authored", importMeta: null,
  createdAt: "2026-01-01", updatedAt: "2026-01-01", ...over,
});

test("listing card maps avatarUrl to the large embed image — that's the gallery cover", () => {
  const bare = buildListingCard(listing(), "me");
  assert.equal(bare.data.image, undefined, "no avatar → no cover image");
  assert.equal(bare.data.thumbnail, undefined, "thumbnail field is never used — it doesn't produce covers");

  const card = buildListingCard(listing({ avatarUrl: "https://cdn.example.com/art.jpg" }), "me");
  assert.equal(card.data.image?.url, "https://cdn.example.com/art.jpg");
});

test("marketplaceAssetPath resolves committed art and refuses traversal", () => {
  assert.ok(marketplaceAssetPath("wren.jpg")?.endsWith("assets\\marketplace\\wren.jpg") || marketplaceAssetPath("wren.jpg")?.endsWith("assets/marketplace/wren.jpg"));
  assert.equal(marketplaceAssetPath("../../secret.pem"), null, "path chars stripped → no traversal");
  assert.equal(marketplaceAssetPath("nope-not-real.png"), null, "missing file → null, not a crash");
});

test("CURATED_TAGS owns the four managed badge names", () => {
  assert.deepEqual({ ...CURATED_TAGS }, { new: "New", topRated: "Top Rated", trending: "Trending", staffPick: "Staff Pick" });
});
