import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListingCard, marketplaceAssetPath, CURATED_TAGS, postListingToDeployments, archiveListingPosts } from "./marketplace.js";
import type { CompanionListing, GuildDeployment } from "./types.js";
import type { MemoryStore } from "./database.js";

const listing = (over: Partial<CompanionListing> = {}): CompanionListing => ({
  id: 1, creatorUserId: "u1", sourceCompanionId: null, name: "Test", tagline: "t",
  voicePersona: "v", coreTraits: [], ownerDynamic: "d", backstory: "b", greeting: "g",
  avatarUrl: null, version: 1, status: "active", addCount: 0, reportCount: 0, forumThreadId: null,
  personaSource: "authored", importMeta: null, creatorTags: [],
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

// ── Mirror fan-out (v59) ─────────────────────────────────────────────────────

const dep = (guildId: string, forumId: string | null): GuildDeployment => ({
  guildId, status: "active", marketplaceChannelId: forumId, adopteesChannelId: null,
  categoryId: null, loginChannelId: null, grantKind: "ops", deployedBy: null, deployedAt: null, lastError: null,
});

test("postListingToDeployments: every active forum gets a card; a dead partner never blocks", async () => {
  const posts: Array<{ listingId: number; guildId: string; threadId: string }> = [];
  const failures: string[] = [];
  const store = {
    listingRatingStats: async () => undefined,
    setListingPost: async (listingId: number, guildId: string, threadId: string) => { posts.push({ listingId, guildId, threadId }); return true; },
    setListingPostFailed: async (_l: number, guildId: string) => { failures.push(guildId); return true; },
  } as unknown as MemoryStore;
  let seq = 0;
  const forums: Record<string, unknown> = {
    "f-house": { type: 15, availableTags: [{ id: "tag-new", name: "New", moderated: true }], threads: { create: async () => ({ id: `t-${++seq}` }) } },
    "f-partner": { type: 15, availableTags: [], threads: { create: async () => ({ id: `t-${++seq}` }) } },
    // "f-dead" deliberately absent — fetch resolves null.
  };
  const res = await postListingToDeployments(
    async (id: string) => forums[id] ?? null,
    [dep("g-house", "f-house"), dep("g-partner", "f-partner"), dep("g-dead", "f-dead"), dep("g-noforum", null)],
    "a creator", listing(), store,
  );
  assert.equal(res.posted.length, 2, "house + partner post");
  assert.equal(res.failed.length, 1, "only the unreachable forum is a failure — a forum-less deployment is skipped, not failed");
  assert.deepEqual(posts.map(p => p.guildId).sort(), ["g-house", "g-partner"]);
  assert.deepEqual(failures, ["g-dead"], "failure recorded for the sync sweep to retry");
});

test("archiveListingPosts: every live mirror locks + archives", async () => {
  const mk = () => ({ locked: false, archived: false, notes: [] as unknown[] });
  const s1 = mk(), s2 = mk();
  const mkThread = (s: typeof s1) => ({
    send: async (o: unknown) => { s.notes.push(o); },
    setLocked: async (b: boolean) => { s.locked = b; },
    setArchived: async (b: boolean) => { s.archived = b; },
  });
  const map: Record<string, unknown> = { "t-1": mkThread(s1), "t-2": mkThread(s2) };
  const n = await archiveListingPosts(async id => map[id] ?? null, [
    { listingId: 1, guildId: "g-house", threadId: "t-1", status: "live", lastError: null },
    { listingId: 1, guildId: "g-partner", threadId: "t-2", status: "live", lastError: null },
    { listingId: 1, guildId: "g-failed", threadId: null, status: "failed", lastError: "x" },
  ], { note: "delisted" });
  assert.equal(n, 2, "null-thread posts skipped, both live mirrors archived");
  assert.equal(s1.locked && s1.archived, true);
  assert.equal(s2.locked && s2.archived, true);
  assert.equal(s1.notes.length, 1, "the note posts before the lock");
});
