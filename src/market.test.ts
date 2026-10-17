import "dotenv/config";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { makeStore, makeTestSql } from "./test-helpers.js";
import type { MemoryStore } from "./database.js";

const HOUR = 3_600_000;
const COOLDOWN = 12 * HOUR;

const sql = makeTestSql();
after(() => sql.end());

function freshStore() {
  return makeStore(sql);
}

async function awakenedCompanion(store: MemoryStore, userId: string, name = "Nyx") {
  return store.activateCompanion(userId, "Owner", {
    name,
    voicePersona: "dry, sharp",
    coreTraits: ["witty"],
    ownerDynamic: "ride-or-die",
    backstory: "met in a chat",
    avatarUrl: null,
  });
}

async function makeListing(store: MemoryStore, creatorId: string, sourceId: number, name = "Nyx") {
  const res = await store.upsertListing(creatorId, sourceId, {
    name,
    tagline: "a very dry vampire",
    voicePersona: "dry, sharp",
    coreTraits: ["witty"],
    ownerDynamic: "protective friend",
    backstory: "old lore",
    greeting: "*looks up* …you again.",
    avatarUrl: null,
  });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("makeListing failed");
  return res.listing;
}

test("marketplace schema: kind column, partial awakened uniqueness, new tables", async () => {
  const { store } = await freshStore();

  const cols = await sql<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'companions' AND column_name IN ('kind','adopted_from_listing_id','listing_version')
  `;
  assert.equal(cols.length, 3);

  const tables = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('companion_listings','companion_persona_versions','companion_adoptions','listing_reports')
  `;
  assert.equal(tables.length, 4);

  // One awakened per owner still enforced…
  await awakenedCompanion(store, "u-uniq", "One");
  await assert.rejects(
    sql`INSERT INTO companions (owner_user_id, name, onboarding_state, kind) VALUES ('u-uniq', 'Two', 'active', 'awakened')`,
    /unique|duplicate/i,
  );
  // …but adopted clones share the owner's id freely.
  await sql`INSERT INTO companions (owner_user_id, name, onboarding_state, kind) VALUES ('u-uniq', 'Clone', 'active', 'adopted')`;
  await sql`INSERT INTO companions (owner_user_id, name, onboarding_state, kind) VALUES ('u-uniq', 'Clone2', 'active', 'adopted')`;

  const settings = await sql<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'user_bot_settings' AND column_name = 'active_dm_companion_id'
  `;
  assert.equal(settings.length, 1);
});

test("publish → upsertListing versions and keeps persona versions", async () => {
  const { store } = await freshStore();
  const companion = await awakenedCompanion(store, "u-creator");

  const v1 = await makeListing(store, "u-creator", companion.id);
  assert.equal(v1.version, 1);
  assert.equal(v1.status, "active");

  const res2 = await store.upsertListing("u-creator", companion.id, {
    name: "Nyx II",
    tagline: "drier than before",
    voicePersona: "drier",
    coreTraits: ["witty", "drier"],
    ownerDynamic: "protective friend",
    backstory: "older lore",
    greeting: "again?",
    avatarUrl: null,
  });
  assert.equal(res2.ok, true);
  if (!res2.ok) return;
  const v2 = res2.listing;
  assert.equal(v2.id, v1.id);
  assert.equal(v2.version, 2);
  assert.equal(v2.tagline, "drier than before");

  const versions = await sql<Array<{ version: number }>>`
    SELECT version FROM companion_persona_versions WHERE listing_id = ${v1.id} ORDER BY version
  `;
  assert.deepEqual(versions.map(v => Number(v.version)), [1, 2]);
});

test("adoptListing clones a companions row owned by the adopter", async () => {
  const { store } = await freshStore();
  const creator = await awakenedCompanion(store, "u-creator2", "Moth");
  const listing = await makeListing(store, "u-creator2", creator.id, "Moth");

  const res = await store.adoptListing("u-adopter", listing.id, { maxSlots: 1 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.reused, false);
  assert.equal(res.companion.kind, "adopted");
  assert.equal(res.companion.ownerUserId, "u-adopter");
  assert.equal(res.companion.onboardingState, "active");
  assert.equal(res.companion.adoptedFromListingId, listing.id);
  assert.equal(res.companion.listingVersion, 1);
  assert.notEqual(res.companion.id, creator.id);
  assert.equal(res.adoption.userId, "u-adopter");
  assert.equal(res.adoption.dmIntroducedAt, null);

  // Idempotent re-click reuses the same clone, doesn't double-count.
  const again = await store.adoptListing("u-adopter", listing.id, { maxSlots: 1 });
  assert.equal(again.ok, true);
  if (again.ok) {
    assert.equal(again.reused, true);
    assert.equal(again.companion.id, res.companion.id);
  }

  // Creator's own listing can't be adopted by them.
  const own = await store.adoptListing("u-creator2", listing.id, { maxSlots: 10 });
  assert.equal(own.ok, false);
  if (!own.ok) assert.equal(own.reason, "own_listing");
});

test("free cap gates fresh adoptions; premium slot ceiling is unbounded", async () => {
  const { store } = await freshStore();
  const creator = await awakenedCompanion(store, "u-c3", "A");
  const listing = await makeListing(store, "u-c3", creator.id, "A");
  const creator2 = await awakenedCompanion(store, "u-c4", "B");
  const listing2 = await makeListing(store, "u-c4", creator2.id, "B");

  // free: 1 slot
  const first = await store.adoptListing("u-free", listing.id, { maxSlots: 1 });
  assert.equal(first.ok, true);
  const second = await store.adoptListing("u-free", listing2.id, { maxSlots: 1 });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "cap");

  // premium: effectively uncapped (caller passes a huge ceiling)
  const p1 = await store.adoptListing("u-premium", listing.id, { maxSlots: Number.MAX_SAFE_INTEGER });
  const p2 = await store.adoptListing("u-premium", listing2.id, { maxSlots: Number.MAX_SAFE_INTEGER });
  assert.equal(p1.ok, true);
  assert.equal(p2.ok, true);
});

test("drop frees the slot, starts a 12h cooldown, re-adopt reuses the clone", async () => {
  const { store } = await freshStore();
  const creator = await awakenedCompanion(store, "u-c5", "Ash");
  const listing = await makeListing(store, "u-c5", creator.id, "Ash");
  const first = await store.adoptListing("u-dropper", listing.id, { maxSlots: 1 });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  await store.summonCompanion("g1", first.companion.id, "u-dropper", "dropper");
  await store.setActiveDmCompanion("u-dropper", first.companion.id);

  const dropped = await store.dropAdoption("u-dropper", first.companion.id, COOLDOWN);
  assert.ok(dropped);
  assert.ok(dropped!.droppedAt);
  assert.ok(dropped!.cooldownUntil);

  // Clone is gone from the roster, out of all guilds, pointer cleared.
  const roster = await store.listCompanionsForUser("u-dropper");
  assert.equal(roster.some(c => c.id === first.companion.id), false);
  const guilds = await store.listCompanionGuilds(first.companion.id);
  assert.equal(guilds.includes("g1"), false);
  assert.equal((await store.resolveDmCompanion("u-dropper"))?.id ?? null, null);

  // Blocked during cooldown…
  const blocked = await store.adoptListing("u-dropper", listing.id, { maxSlots: 1 });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, "cooldown");

  // …and once it expires, re-adopting reuses the same clone + relationship.
  await sql`UPDATE companion_adoptions SET cooldown_until = NOW() - INTERVAL '1 minute' WHERE id = ${dropped!.id}`;
  const reAdopt = await store.adoptListing("u-dropper", listing.id, { maxSlots: 1 });
  assert.equal(reAdopt.ok, true);
  if (reAdopt.ok) {
    assert.equal(reAdopt.reused, true);
    assert.equal(reAdopt.companion.id, first.companion.id);
    assert.equal(reAdopt.adoption.droppedAt, null);
    assert.equal(reAdopt.adoption.cooldownUntil, null);
  }
});

test("resolveDmCompanion honors the pick and falls back to awakened", async () => {
  const { store } = await freshStore();
  const awakened = await awakenedCompanion(store, "u-picker", "Home");
  const creator = await awakenedCompanion(store, "u-c6", "Guest");
  const listing = await makeListing(store, "u-c6", creator.id, "Guest");
  const adopted = await store.adoptListing("u-picker", listing.id, { maxSlots: 1 });
  assert.equal(adopted.ok, true);
  if (!adopted.ok) return;

  // Default: awakened wins while no pick exists.
  assert.equal((await store.resolveDmCompanion("u-picker"))!.id, awakened.id);

  await store.setActiveDmCompanion("u-picker", adopted.companion.id);
  const resolved = await store.resolveDmCompanion("u-picker");
  assert.equal(resolved!.id, adopted.companion.id);
  assert.equal(resolved!.kind, "adopted");

  // getCompanionByOwner never returns the clone.
  assert.equal((await store.getCompanionByOwner("u-picker"))!.id, awakened.id);

  // Dropping clears the pick → back to awakened.
  await store.dropAdoption("u-picker", adopted.companion.id, COOLDOWN);
  assert.equal((await store.resolveDmCompanion("u-picker"))!.id, awakened.id);
});

test("listing edits propagate persona to clones but not adopter-owned state", async () => {
  const { store } = await freshStore();
  const creator = await awakenedCompanion(store, "u-c7", "Old Name");
  const listing = await makeListing(store, "u-c7", creator.id, "Old Name");
  const adopt = await store.adoptListing("u-ad7", listing.id, { maxSlots: 1 });
  assert.equal(adopt.ok, true);
  if (!adopt.ok) return;

  await store.summonCompanion("g7", adopt.companion.id, "u-ad7", "ad7");

  const res = await store.upsertListing("u-c7", creator.id, {
    name: "New Name",
    tagline: "new tag",
    voicePersona: "new voice",
    coreTraits: ["new"],
    ownerDynamic: "new bond",
    backstory: "new lore",
    greeting: "hi v2",
    avatarUrl: null,
  });
  assert.equal(res.ok, true);

  const clone = await store.getCompanionById(adopt.companion.id);
  assert.equal(clone!.name, "New Name");
  assert.equal(clone!.voicePersona, "new voice");
  assert.deepEqual(clone!.coreTraits, ["new"]);
  assert.equal(clone!.listingVersion, 2);
  // Creator's own awakened companion is untouched.
  const creatorNow = await store.getCompanionByOwner("u-c7");
  assert.equal(creatorNow!.name, "Old Name");
  // Guild presence (adopter state) survives propagation.
  assert.deepEqual(await store.listCompanionGuilds(adopt.companion.id), ["g7"]);
});

test("reports dedupe per user, count up, flag blocks new adds; delist blocks adds", async () => {
  const { store } = await freshStore();
  const creator = await awakenedCompanion(store, "u-c8", "Flag");
  const listing = await makeListing(store, "u-c8", creator.id, "Flag");

  const r1 = await store.reportListing(listing.id, "u-r1");
  assert.ok(r1.ok && r1.count === 1);
  const dup = await store.reportListing(listing.id, "u-r1");
  assert.ok(!dup.ok && dup.reason === "dup");
  const r2 = await store.reportListing(listing.id, "u-r2");
  assert.ok(r2.ok && r2.count === 2);

  assert.equal(await store.flagListing(listing.id), true);
  const blocked = await store.adoptListing("u-r3", listing.id, { maxSlots: 1 });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, "delisted");

  // Delist holds a flagged row (see the moderation-hold test) — use a
  // separate active listing for the delist-blocks-adds check.
  const creator2 = await awakenedCompanion(store, "u-c9", "Plain");
  const plain = await makeListing(store, "u-c9", creator2.id, "Plain");
  assert.equal(await store.delistListing(plain.id), true);
  assert.equal((await store.listingById(plain.id))!.status, "delisted");
});

test("a flagged listing is a moderation hold — delist/relist/republish can't launder it", async () => {
  const { store } = await freshStore();
  const creator = await awakenedCompanion(store, "u-flag", "Flagged");
  const listing = await makeListing(store, "u-flag", creator.id, "Flagged");

  assert.equal(await store.flagListing(listing.id), true);
  // Re-flagging an already-flagged row is a no-op, not a flip.
  assert.equal(await store.flagListing(listing.id), false);

  // The creator cannot delist a flagged row — delisting would erase the
  // flag, and relist/republish would then revive the listing as 'active'.
  assert.equal(await store.delistListing(listing.id), false);
  assert.equal((await store.listingById(listing.id))!.status, "flagged");

  const relisted = await store.relistListing(listing.id, "u-flag", 10);
  assert.equal(relisted.ok, false);
  if (!relisted.ok) assert.equal(relisted.reason, "not_delisted");

  // Republish saves the persona edits but keeps the flag — no fresh life.
  const repub = await store.upsertListing("u-flag", creator.id, {
    name: "Flagged v2", tagline: "t", voicePersona: "v", coreTraits: ["x"],
    ownerDynamic: "d", backstory: "b", greeting: "g", avatarUrl: null,
  }, { maxListings: 10 });
  assert.equal(repub.ok, true);
  const after = await store.listingById(listing.id);
  assert.equal(after!.status, "flagged");
  assert.equal(after!.name, "Flagged v2");

  // flagListing can't flip a delisted row back to flagged either.
  const creator2 = await awakenedCompanion(store, "u-flag2", "Plain");
  const plain = await makeListing(store, "u-flag2", creator2.id, "Plain");
  assert.equal(await store.delistListing(plain.id), true);
  assert.equal(await store.flagListing(plain.id), false);
  const gone = await store.adoptListing("u-anyone", plain.id, { maxSlots: 1 });
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.equal(gone.reason, "delisted");
});

test("freehand listings: createListing works without an awakened source, adopts cleanly", async () => {
  const { store } = await freshStore();
  const res = await store.createListing("u-freehand", {
    name: "Standalone",
    tagline: "no awakened backing",
    voicePersona: "oddly polite",
    coreTraits: ["polite"],
    ownerDynamic: "a companion who met you here",
    backstory: "made for the shelf",
    greeting: "hello, adopter.",
    avatarUrl: null,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const listing = res.listing;
  assert.equal(listing.sourceCompanionId, null);
  assert.equal(listing.version, 1);

  const adopt = await store.adoptListing("u-freehand-adopter", listing.id, { maxSlots: 1 });
  assert.equal(adopt.ok, true);
  if (adopt.ok) {
    assert.equal(adopt.companion.kind, "adopted");
    assert.equal(adopt.companion.ownerUserId, "u-freehand-adopter");
    assert.equal(adopt.companion.name, "Standalone");
  }
});

test("activeListingCount/listMyListings drive the publish cap; delist frees the slot", async () => {
  const { store } = await freshStore();
  const awakened = await awakenedCompanion(store, "u-author", "Backed");
  assert.equal(await store.activeListingCount("u-author"), 0);

  await makeListing(store, "u-author", awakened.id, "Backed");
  await store.createListing("u-author", {
    name: "Extra", tagline: "t", voicePersona: "v", coreTraits: [],
    ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: null,
  });
  assert.equal(await store.activeListingCount("u-author"), 2);
  assert.equal((await store.listMyListings("u-author")).length, 2);

  // Delisting frees a slot.
  const mine = await store.listMyListings("u-author");
  await store.delistListing(mine[0].id);
  assert.equal(await store.activeListingCount("u-author"), 1);
  assert.equal((await store.listMyListings("u-author")).length, 1);
});

test("updateListing edits a freehand listing, bumps version, propagates to clones", async () => {
  const { store } = await freshStore();
  const res = await store.createListing("u-editor", {
    name: "Before", tagline: "t", voicePersona: "v1", coreTraits: [],
    ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: null,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const listing = res.listing;
  const adopt = await store.adoptListing("u-ad-editor", listing.id, { maxSlots: 1 });
  assert.equal(adopt.ok, true);
  if (!adopt.ok) return;

  const updated = await store.updateListing(listing.id, "u-editor", {
    name: "After", tagline: "t2", voicePersona: "v2", coreTraits: ["new"],
    ownerDynamic: "d2", backstory: "b2", greeting: "g2", avatarUrl: null,
  });
  assert.equal(updated!.version, 2);

  const clone = await store.getCompanionById(adopt.companion.id);
  assert.equal(clone!.name, "After");
  assert.equal(clone!.voicePersona, "v2");

  // Another creator's id can't update someone else's listing.
  const foreign = await store.updateListing(listing.id, "u-other", {
    name: "Hijack", tagline: "t", voicePersona: "v", coreTraits: [],
    ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: null,
  });
  assert.equal(foreign, null);
  assert.equal((await store.listingById(listing.id))!.name, "After");
});

test("republish revives a delisted listing but never clears a moderation flag", async () => {
  const { store } = await freshStore();
  const awakened = await awakenedCompanion(store, "u-flagged", "Flaggy");
  const listing = await makeListing(store, "u-flagged", awakened.id, "Flaggy");

  await store.flagListing(listing.id);
  const republished = await makeListing(store, "u-flagged", awakened.id, "Flaggy");
  assert.equal(republished.status, "flagged", "republish must not launder a flag");

  // A flagged row can't delist (moderation hold), so the revive half uses a
  // second listing.
  const awakened2 = await awakenedCompanion(store, "u-revive", "Rev");
  const delisted = await makeListing(store, "u-revive", awakened2.id, "Rev");
  assert.equal(await store.delistListing(delisted.id), true);
  const revived = await makeListing(store, "u-revive", awakened2.id, "Rev");
  assert.equal(revived.status, "active", "republish revives a delisted listing");
});

test("markDmIntroduced stamps the adoption; roster lists awakened then adopted", async () => {
  const { store } = await freshStore();
  const awakened = await awakenedCompanion(store, "u-i", "Main");
  const creator = await awakenedCompanion(store, "u-c9", "Side");
  const listing = await makeListing(store, "u-c9", creator.id, "Side");
  const adopt = await store.adoptListing("u-i", listing.id, { maxSlots: 1 });
  assert.equal(adopt.ok, true);
  if (!adopt.ok) return;

  assert.equal(adopt.adoption.dmIntroducedAt, null);
  await store.markDmIntroduced(adopt.adoption.id);
  const after = await store.adoptionForCompanion(adopt.companion.id);
  assert.ok(after!.dmIntroducedAt);

  const roster = await store.listCompanionsForUser("u-i");
  assert.deepEqual(roster.map(c => c.id), [awakened.id, adopt.companion.id]);
});

test("re-adoption after cooldown still consumes the free slot cap", async () => {
  const { store } = await freshStore();
  const c1 = await awakenedCompanion(store, "u-cap1", "A");
  const listingA = await makeListing(store, "u-cap1", c1.id, "A");
  const c2 = await awakenedCompanion(store, "u-cap2", "B");
  const listingB = await makeListing(store, "u-cap2", c2.id, "B");

  // Free user (1 slot): adopt A, drop A, adopt B — all legal.
  const first = await store.adoptListing("u-cycler", listingA.id, { maxSlots: 1 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await store.dropAdoption("u-cycler", first.companion.id, COOLDOWN);
  const second = await store.adoptListing("u-cycler", listingB.id, { maxSlots: 1 });
  assert.equal(second.ok, true);
  assert.equal(await store.activeAdoptionCount("u-cycler"), 1);

  // Once A's cooldown expires, re-adopting it must respect the cap — the
  // slot is already held by B.
  await sql`UPDATE companion_adoptions SET cooldown_until = NOW() - INTERVAL '1 minute' WHERE user_id = 'u-cycler'`;
  const reAdopt = await store.adoptListing("u-cycler", listingA.id, { maxSlots: 1 });
  assert.equal(reAdopt.ok, false);
  if (!reAdopt.ok) assert.equal(reAdopt.reason, "cap");
  assert.equal(await store.activeAdoptionCount("u-cycler"), 1);

  // Dropping B frees the slot — then re-adopting A works and reuses the clone.
  if (second.ok) await store.dropAdoption("u-cycler", second.companion.id, COOLDOWN);
  const freed = await store.adoptListing("u-cycler", listingA.id, { maxSlots: 1 });
  assert.equal(freed.ok, true);
  if (freed.ok) assert.equal(freed.companion.id, first.companion.id);
});

test("parallel adoptions on different listings can't both beat the cap", async () => {
  const { store } = await freshStore();
  const c1 = await awakenedCompanion(store, "u-par1", "A");
  const listingA = await makeListing(store, "u-par1", c1.id, "A");
  const c2 = await awakenedCompanion(store, "u-par2", "B");
  const listingB = await makeListing(store, "u-par2", c2.id, "B");

  // Two simultaneous Adds on different listings — the per-user advisory lock
  // serializes them, so exactly one wins the single free slot.
  const [r1, r2] = await Promise.all([
    store.adoptListing("u-racer", listingA.id, { maxSlots: 1 }),
    store.adoptListing("u-racer", listingB.id, { maxSlots: 1 }),
  ]);
  const oks = [r1, r2].filter(r => r.ok);
  const caps = [r1, r2].filter(r => !r.ok && r.reason === "cap");
  assert.equal(oks.length, 1);
  assert.equal(caps.length, 1);
  assert.equal(await store.activeAdoptionCount("u-racer"), 1);
});

test("add_count only counts fresh adoptions, not re-adopt cycles", async () => {
  const { store } = await freshStore();
  const creator = await awakenedCompanion(store, "u-cnt", "Pop");
  const listing = await makeListing(store, "u-cnt", creator.id, "Pop");

  const adopt = await store.adoptListing("u-cnt-a", listing.id, { maxSlots: 5 });
  assert.equal(adopt.ok, true);
  if (!adopt.ok) return;
  await store.dropAdoption("u-cnt-a", adopt.companion.id, COOLDOWN);
  await sql`UPDATE companion_adoptions SET cooldown_until = NOW() - INTERVAL '1 minute' WHERE user_id = 'u-cnt-a'`;
  const reAdopt = await store.adoptListing("u-cnt-a", listing.id, { maxSlots: 5 });
  assert.equal(reAdopt.ok, true);

  assert.equal((await store.listingById(listing.id))!.addCount, 1);
});

test("listing cap: create/upsert/relist enforce it atomically inside the write", async () => {
  const { store } = await freshStore();
  const spec = (name: string) => ({
    name, tagline: "t", voicePersona: "v", coreTraits: [] as string[],
    ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: null,
  });

  // Two freehand creates fill the 2-slot cap; a third is refused.
  const a = await store.createListing("u-lcap", spec("A"), { maxListings: 2 });
  const b = await store.createListing("u-lcap", spec("B"), { maxListings: 2 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const third = await store.createListing("u-lcap", spec("C"), { maxListings: 2 });
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.reason, "cap");

  // Awakened-backed publish also respects it — then delist frees a slot.
  const awakened = await awakenedCompanion(store, "u-lcap", "Backed");
  const blocked = await store.upsertListing("u-lcap", awakened.id, spec("Backed"), { maxListings: 2 });
  assert.equal(blocked.ok, false);
  if (!a.ok || !b.ok) return;
  await store.delistListing(a.listing.id);
  const backed = await store.upsertListing("u-lcap", awakened.id, spec("Backed"), { maxListings: 2 });
  assert.equal(backed.ok, true);
  if (!backed.ok) return;
  assert.equal(backed.listing.status, "active");

  // Delisting that backed listing + a fresh create re-fills the cap; the
  // republish (revive) is now refused — it would push the live count to 3.
  await store.delistListing(backed.listing.id);
  const refill = await store.createListing("u-lcap", spec("D"), { maxListings: 2 });
  assert.equal(refill.ok, true);
  const revive = await store.upsertListing("u-lcap", awakened.id, spec("Backed v2"), { maxListings: 2 });
  assert.equal(revive.ok, false);
  if (!revive.ok) assert.equal(revive.reason, "cap");

  // But relisting works once a slot frees — and only from 'delisted'.
  if (!refill.ok) return;
  await store.delistListing(refill.listing.id);
  const relisted = await store.relistListing(backed.listing.id, "u-lcap", 2);
  assert.equal(relisted.ok, true);
  if (relisted.ok) assert.equal(relisted.listing.status, "active");

  const again = await store.relistListing(backed.listing.id, "u-lcap", 2);
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.reason, "not_delisted");
  const foreign = await store.relistListing(backed.listing.id, "u-stranger", 2);
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.reason, "not_found");
});

test("parallel creates can't both beat the listing cap", async () => {
  const { store } = await freshStore();
  const spec = (name: string) => ({
    name, tagline: "t", voicePersona: "v", coreTraits: [] as string[],
    ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: null,
  });
  const [r1, r2] = await Promise.all([
    store.createListing("u-pc", spec("A"), { maxListings: 1 }),
    store.createListing("u-pc", spec("B"), { maxListings: 1 }),
  ]);
  assert.equal([r1, r2].filter(r => r.ok).length, 1);
  assert.equal([r1, r2].filter(r => !r.ok && r.reason === "cap").length, 1);
  assert.equal(await store.activeListingCount("u-pc"), 1);
});

test("reportListing stores the category; dailyReportCount counts today's rows", async () => {
  const { store } = await freshStore();
  const creator = await awakenedCompanion(store, "u-rc", "Rep");
  const listing = await makeListing(store, "u-rc", creator.id, "Rep");

  const n = await store.reportListing(listing.id, "u-rep1", "hate");
  assert.ok(n.ok && n.count === 1);
  const row = await sql<Array<{ category: string }>>`SELECT category FROM listing_reports WHERE listing_id = ${listing.id}`;
  assert.equal(row[0].category, "hate");
  assert.equal(await store.dailyReportCount("u-rep1"), 1);
  // Backdating drops it out of the window.
  await sql`UPDATE listing_reports SET created_at = NOW() - INTERVAL '2 days' WHERE reporter_user_id = 'u-rep1'`;
  assert.equal(await store.dailyReportCount("u-rep1"), 0);
});

test("banned listings freeze clones everywhere — roster, DM resolution, guilds; adopters keep memories", async () => {
  const { store } = await freshStore();
  const creator = await awakenedCompanion(store, "u-ban", "Baddie");
  const listing = await makeListing(store, "u-ban", creator.id, "Baddie");

  const adopt = await store.adoptListing("u-ad-ban", listing.id, { maxSlots: 5 });
  assert.equal(adopt.ok, true);
  if (!adopt.ok) return;
  await store.summonCompanion("g-ban", adopt.companion.id, "u-ad-ban", "ad");
  await store.setActiveDmCompanion("u-ad-ban", adopt.companion.id);

  // Baseline: clone is live everywhere.
  assert.equal((await store.resolveDmCompanion("u-ad-ban"))?.id, adopt.companion.id);
  assert.equal((await store.listCompanionsForUser("u-ad-ban")).length, 1);
  assert.equal((await store.listGuildCompanions("g-ban")).length, 1);

  const banned = await store.modAction(listing.id, "mod-1", "ban");
  assert.equal(banned?.status, "banned");

  // Clone is frozen: invisible in roster, DM resolution skips it (falls to
  // awakened → null here), and guild presence stops.
  assert.equal((await store.listCompanionsForUser("u-ad-ban")).length, 0);
  assert.equal(await store.resolveDmCompanion("u-ad-ban"), null);
  assert.equal((await store.listGuildCompanions("g-ban")).length, 0);

  // New adoption refused; the row still exists for the audit trail.
  const readd = await store.adoptListing("u-ad-ban2", listing.id, { maxSlots: 5 });
  assert.equal(readd.ok, false);
  assert.equal((await store.listingById(listing.id))!.status, "banned");

  // Audit trail captured actor + action.
  const events = await sql<Array<{ action: string; actor_user_id: string }>>`
    SELECT action, actor_user_id FROM moderation_events WHERE listing_id = ${listing.id}
  `;
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "ban");
  assert.equal(events[0].actor_user_id, "mod-1");
});

test("modAction: unflag clears a hold, delist keeps clones, ban is irreversible via creator paths", async () => {
  const { store } = await freshStore();
  const c = await awakenedCompanion(store, "u-mod", "M");
  const listing = await makeListing(store, "u-mod", c.id, "M");

  // unflag only acts on flagged rows.
  assert.equal(await store.modAction(listing.id, "m1", "unflag"), null);
  await store.flagListing(listing.id);
  const cleared = await store.modAction(listing.id, "m1", "unflag");
  assert.equal(cleared?.status, "active");

  // mod delist can take a flagged listing down (creator delist cannot).
  await store.flagListing(listing.id);
  assert.equal(await store.delistListing(listing.id), false);
  const dl = await store.modAction(listing.id, "m1", "delist");
  assert.equal(dl?.status, "delisted");

  // ban from delisted too; creator relist can't undo it.
  const banned = await store.modAction(listing.id, "m1", "ban");
  assert.equal(banned?.status, "banned");
  const relist = await store.relistListing(listing.id, "u-mod", 5);
  assert.equal(relist.ok, false);
});

test("banCreator publish-bans and freezes all their live listings", async () => {
  const { store } = await freshStore();
  const c = await awakenedCompanion(store, "u-bc", "Bad");
  const l1 = await makeListing(store, "u-bc", c.id, "Bad");
  const l2res = await store.createListing("u-bc", {
    name: "Free", tagline: "t", voicePersona: "v", coreTraits: [],
    ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: null,
  }, { maxListings: 10 });
  assert.equal(l2res.ok, true);
  if (!l2res.ok) return;

  const adopt = await store.adoptListing("u-adbc", l1.id, { maxSlots: 5 });
  assert.equal(adopt.ok, true);

  const affected = await store.banCreator("u-bc", "mod-9", "spam network");
  assert.equal(affected.length, 2);
  assert.equal((await store.listingById(l1.id))!.status, "banned");
  assert.equal((await store.listingById(l2res.listing.id))!.status, "banned");
  // Clones frozen.
  assert.equal((await store.listCompanionsForUser("u-adbc")).length, 0);
  // Ban row exists.
  const ban = await store.creatorBan("u-bc");
  assert.equal(ban?.reason, "spam network");
  // Re-ban idempotent — no dupes, no new events.
  const again = await store.banCreator("u-bc", "mod-9", "still banned");
  assert.equal(again.length, 0);
});

test("daily counters: publish + adopt windows", async () => {
  const { store } = await freshStore();
  const c = await awakenedCompanion(store, "u-dc", "D");
  const listing = await makeListing(store, "u-dc", c.id, "D");
  assert.equal(await store.dailyPublishCount("u-dc"), 1);

  const adopt = await store.adoptListing("u-dca", listing.id, { maxSlots: 5 });
  assert.equal(adopt.ok, true);
  assert.equal(await store.dailyAdoptCount("u-dca"), 1);

  await sql`UPDATE companion_adoptions SET adopted_at = NOW() - INTERVAL '2 days' WHERE user_id = 'u-dca'`;
  await sql`UPDATE companion_listings SET created_at = NOW() - INTERVAL '2 days' WHERE id = ${listing.id}`;
  assert.equal(await store.dailyAdoptCount("u-dca"), 0);
  assert.equal(await store.dailyPublishCount("u-dc"), 0);
});

test("a banned listing's frozen adoption frees the adopter's slot", async () => {
  const { store } = await freshStore();
  const c1 = await awakenedCompanion(store, "u-frz1", "One");
  const l1 = await makeListing(store, "u-frz1", c1.id, "One");
  const c2 = await awakenedCompanion(store, "u-frz2", "Two");
  const l2 = await makeListing(store, "u-frz2", c2.id, "Two");

  // Free-tier slot (1) filled by the first adoption.
  const a1 = await store.adoptListing("u-freezer", l1.id, { maxSlots: 1 });
  assert.equal(a1.ok, true);
  assert.equal(await store.activeAdoptionCount("u-freezer"), 1);
  const capped = await store.adoptListing("u-freezer", l2.id, { maxSlots: 1 });
  assert.equal(capped.ok, false);

  // Banning l1 freezes the clone — the slot is released so the user isn't
  // permanently stuck with a ghost they can't see or drop.
  await store.modAction(l1.id, "mod-x", "ban");
  assert.equal(await store.activeAdoptionCount("u-freezer"), 0);
  const a2 = await store.adoptListing("u-freezer", l2.id, { maxSlots: 1 });
  assert.equal(a2.ok, true);
  // The adoption row itself is preserved — unbanning restores the clone.
  const kept = await store.adoptionFor("u-freezer", l1.id);
  assert.ok(kept && !kept.droppedAt);
});

test("mod takedowns can't be creator-relisted or republished; unflag restores", async () => {
  const { store } = await freshStore();
  const c = await awakenedCompanion(store, "u-mt", "Mod");
  const listing = await makeListing(store, "u-mt", c.id, "Mod");

  // A creator delist stays reversible…
  await store.delistListing(listing.id);
  const own = await store.relistListing(listing.id, "u-mt", 5);
  assert.equal(own.ok, true);
  assert.equal(own.ok && own.listing.status, "active");

  // …but a MOD delist is a takedown the creator can't undo.
  const modDelist = await store.modAction(listing.id, "mod-y", "delist");
  assert.equal(modDelist?.status, "delisted");
  const relist = await store.relistListing(listing.id, "u-mt", 5);
  assert.equal(relist.ok, false);
  if (!relist.ok) assert.equal(relist.reason, "moderated");
  // …and it stays out of the relist picker.
  assert.equal((await store.listDelistedListings("u-mt")).length, 0);
  // …and a republish saves persona edits but keeps the listing down.
  const repub = await store.upsertListing("u-mt", c.id, {
    name: "Mod", tagline: "v2", voicePersona: "v", coreTraits: [],
    ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: null,
  });
  assert.equal(repub.ok, true);
  if (repub.ok) assert.equal(repub.listing.status, "delisted");

  // Only a mod can bring it back — unflag restores a mod-delisted row.
  const restored = await store.modAction(listing.id, "mod-y", "unflag");
  assert.equal(restored?.status, "active");

  // banned → unflag goes back to flagged (review queue), not straight live.
  await store.modAction(listing.id, "mod-y", "ban");
  const unbanned = await store.modAction(listing.id, "mod-y", "unflag");
  assert.equal(unbanned?.status, "flagged");
  // …and from flagged it clears fully.
  const cleared = await store.modAction(listing.id, "mod-y", "unflag");
  assert.equal(cleared?.status, "active");

  // Once the takedown is resolved by an unflag, a later creator unpublish is
  // ordinary again — relistable and back in the picker (stale mod events
  // must not haunt the listing forever).
  await store.delistListing(listing.id);
  assert.equal((await store.listDelistedListings("u-mt")).length, 1);
  const relisted = await store.relistListing(listing.id, "u-mt", 5);
  assert.equal(relisted.ok, true);
});

test("daily publish cap is enforced inside the write tx — new rows only", async () => {
  const { store } = await freshStore();
  const spec = (name: string) => ({
    name, tagline: "t", voicePersona: "v", coreTraits: [] as string[],
    ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: null,
  });
  const c = await awakenedCompanion(store, "u-dp", "DP");

  const first = await store.upsertListing("u-dp", c.id, spec("DP"), { maxDailyPublish: 1 });
  assert.equal(first.ok, true);
  // A second NEW row the same day refuses…
  const second = await store.createListing("u-dp", spec("DP2"), { maxDailyPublish: 1 });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "daily_cap");
  // …but a republish of the existing row isn't a new listing — allowed.
  const repub = await store.upsertListing("u-dp", c.id, spec("DP v2"), { maxDailyPublish: 1 });
  assert.equal(repub.ok, true);
  // Parallel new creates can't both slide under the cap either.
  const [r1, r2] = await Promise.all([
    store.createListing("u-dp2", spec("A"), { maxDailyPublish: 1 }),
    store.createListing("u-dp2", spec("B"), { maxDailyPublish: 1 }),
  ]);
  assert.equal([r1, r2].filter(r => r.ok).length, 1);
  assert.equal([r1, r2].filter(r => !r.ok && r.reason === "daily_cap").length, 1);
});

test("daily report cap is enforced inside reportListing's tx", async () => {
  const { store } = await freshStore();
  const c1 = await awakenedCompanion(store, "u-rc1", "R1");
  const l1 = await makeListing(store, "u-rc1", c1.id, "R1");
  const c2 = await awakenedCompanion(store, "u-rc2", "R2");
  const l2 = await makeListing(store, "u-rc2", c2.id, "R2");

  const r1 = await store.reportListing(l1.id, "u-bomber", "spam", "", 1);
  assert.ok(r1.ok);
  const r2 = await store.reportListing(l2.id, "u-bomber", "spam", "", 1);
  assert.ok(!r2.ok && r2.reason === "daily_cap");
});

test("daily adopt cap is enforced inside adoptListing's tx", async () => {
  const { store } = await freshStore();
  const c1 = await awakenedCompanion(store, "u-ac1", "A1");
  const l1 = await makeListing(store, "u-ac1", c1.id, "A1");
  const c2 = await awakenedCompanion(store, "u-ac2", "A2");
  const l2 = await makeListing(store, "u-ac2", c2.id, "A2");

  const a1 = await store.adoptListing("u-farmer", l1.id, { maxSlots: 10, maxDaily: 1 });
  assert.equal(a1.ok, true);
  const a2 = await store.adoptListing("u-farmer", l2.id, { maxSlots: 10, maxDaily: 1 });
  assert.equal(a2.ok, false);
  if (!a2.ok) assert.equal(a2.reason, "daily_cap");
  // …and a re-click on the same live adoption stays a free no-op.
  const noop = await store.adoptListing("u-farmer", l1.id, { maxSlots: 10, maxDaily: 1 });
  assert.equal(noop.ok, true);
});

// ── v37: ratings + comment reports ───────────────────────────────────────────

test("rateListing upserts one row per rater; stats reflect the latest vote", async () => {
  const { store } = await freshStore();
  const c = await awakenedCompanion(store, "u-rate-c", "R");
  const l = await makeListing(store, "u-rate-c", c.id, "R");

  assert.deepEqual(await store.listingRatingStats(l.id), { avg: 0, count: 0 });

  await store.rateListing(l.id, "u-rater1", 4);
  assert.deepEqual(await store.listingRatingStats(l.id), { avg: 4, count: 1 });

  await store.rateListing(l.id, "u-rater2", 2);
  assert.deepEqual(await store.listingRatingStats(l.id), { avg: 3, count: 2 });

  // A re-rate is an upsert — count doesn't grow, the vote moves.
  await store.rateListing(l.id, "u-rater1", 5);
  const stats = await store.listingRatingStats(l.id);
  assert.equal(stats.count, 2);
  assert.equal(stats.avg, 3.5);
});

test("listingByThreadId resolves a forum thread to its listing", async () => {
  const { store } = await freshStore();
  const c = await awakenedCompanion(store, "u-thr", "T");
  const l = await makeListing(store, "u-thr", c.id, "T");
  assert.equal(await store.listingByThreadId("thr-none"), null, "no thread bound yet");
  await store.setListingThread(l.id, "thr-123");
  assert.equal((await store.listingByThreadId("thr-123"))?.id, l.id);
  assert.equal(await store.listingByThreadId("thr-other"), null);
});

test("reportComment dedupes per (message, reporter) and shares the daily report cap with listing reports", async () => {
  const { store } = await freshStore();
  const c = await awakenedCompanion(store, "u-cr", "C");
  const l = await makeListing(store, "u-cr", c.id, "C");

  const rep = { listingId: l.id, threadId: "thr-1", messageId: "msg-1", authorUserId: "u-author", reporterUserId: "u-rep", category: "spam" };
  assert.ok((await store.reportComment(rep, 10)).ok);
  // Same comment, same reporter — deduped.
  const dup = await store.reportComment(rep, 10);
  assert.ok(!dup.ok && dup.reason === "dup");
  // Same reporter, different comment — a new report.
  assert.ok((await store.reportComment({ ...rep, messageId: "msg-2" }, 10)).ok);
  // A different reporter on the same comment — also a new report.
  assert.ok((await store.reportComment({ ...rep, reporterUserId: "u-rep2" }, 10)).ok);

  // The reporter's daily budget is shared across both report lanes — a
  // listing report consumes the same ceiling a comment report does.
  const c2 = await awakenedCompanion(store, "u-cr2", "D");
  const l2 = await makeListing(store, "u-cr2", c2.id, "D");
  assert.ok((await store.reportListing(l2.id, "u-mixed", "spam", "", 2)).ok);
  assert.ok((await store.reportComment({ listingId: l2.id, threadId: "thr-2", messageId: "msg-9", authorUserId: "u-author", reporterUserId: "u-mixed" }, 2)).ok);
  const over = await store.reportComment({ listingId: l2.id, threadId: "thr-2", messageId: "msg-10", authorUserId: "u-author", reporterUserId: "u-mixed" }, 2);
  assert.ok(!over.ok && over.reason === "daily_cap");

  // commentReportFor lets the mod timeout resolve the author from the row,
  // not the (forgeable) button id.
  assert.equal((await store.commentReportFor("msg-1"))?.authorUserId, "u-author");
  assert.equal(await store.commentReportFor("msg-nope"), null);
});

test("parallel comment reports can't both slip under the daily cap", async () => {
  const { store } = await freshStore();
  const c = await awakenedCompanion(store, "u-pcr", "P");
  const l = await makeListing(store, "u-pcr", c.id, "P");
  const [r1, r2] = await Promise.all([
    store.reportComment({ listingId: l.id, threadId: "t", messageId: "pa", authorUserId: "a", reporterUserId: "u-pcap" }, 1),
    store.reportComment({ listingId: l.id, threadId: "t", messageId: "pb", authorUserId: "a", reporterUserId: "u-pcap" }, 1),
  ]);
  assert.equal([r1, r2].filter(r => r.ok).length, 1);
  assert.equal([r1, r2].filter(r => !r.ok && r.reason === "daily_cap").length, 1);
});

test("tag sweep feeds: thread-scoped listings, bulk rating stats, adoption velocity window", async () => {
  const { store } = await freshStore();
  const c1 = await awakenedCompanion(store, "u-tag1", "One");
  const l1 = await makeListing(store, "u-tag1", c1.id, "One");
  const c2 = await awakenedCompanion(store, "u-tag2", "Two");
  const l2 = await makeListing(store, "u-tag2", c2.id, "Two");
  const c3 = await awakenedCompanion(store, "u-tag3", "Three");
  const l3 = await makeListing(store, "u-tag3", c3.id, "Three");

  // Only active listings WITH a thread qualify — l3 stays threadless, l2 delists.
  await store.setListingThread(l1.id, "t-1");
  await store.setListingThread(l2.id, "t-2");
  await store.delistListing(l2.id);

  const withThreads = await store.listActiveListingsWithThreads();
  assert.deepEqual(withThreads.map(l => l.id), [l1.id]);

  // Ratings: l1 gets four 5s + two 4s (avg 4.67, count 6); l2 a lone 2.
  for (const [u, s] of [["r1",5],["r2",5],["r3",5],["r4",5],["r5",4],["r6",4]] as const) {
    await store.rateListing(l1.id, u, s);
  }
  await store.rateListing(l2.id, "r9", 2);
  const stats = await store.ratingStatsByListing();
  assert.equal(stats.get(l1.id)!.count, 6);
  assert.ok(Math.abs(stats.get(l1.id)!.avg - 28 / 6) < 0.001);
  assert.equal(stats.get(l2.id)!.count, 1);

  // Velocity: 3 adoptions on l1, but one backdated outside the 72h window.
  for (const u of ["u-a1", "u-a2", "u-a3"]) await store.adoptListing(u, l1.id, { maxSlots: 10 });
  await sql`UPDATE companion_adoptions SET adopted_at = NOW() - INTERVAL '5 days' WHERE user_id = 'u-a3'`;
  const counts = await store.recentAdoptionCounts(72 * HOUR);
  assert.equal(counts.get(l1.id), 2);
  assert.equal(counts.get(l3.id) ?? 0, 0);
  const wide = await store.recentAdoptionCounts(30 * 24 * HOUR);
  assert.equal(wide.get(l1.id), 3);
});

// ── Character-card imports ───────────────────────────────────────────────────

const IMPORT_SPEC = {
  name: "Lirael",
  tagline: "A librarian who talks to the dead",
  voicePersona: "curious, soft-spoken",
  coreTraits: ["curious", "brave"],
  ownerDynamic: "Companion",
  backstory: "The Old Kingdom",
  greeting: "*looks up* oh — you're alive. Good.",
  avatarUrl: null,
};

test("unlisted import: creator self-adopts, strangers refused, provenance stamped", async () => {
  const { store } = await freshStore();
  const meta = { source: "character_card", creator: "some-author", sha256: "abc123", spec: "chara_card_v2" };
  const created = await store.createListing("u-importer", IMPORT_SPEC, {
    status: "unlisted", personaSource: "card_import", importMeta: meta,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const listing = created.listing;
  assert.equal(listing.status, "unlisted");
  assert.equal(listing.personaSource, "card_import");
  assert.deepEqual(listing.importMeta!.sha256, "abc123");

  // A stranger can't adopt a private import.
  const stranger = await store.adoptListing("u-stranger", listing.id, { maxSlots: 10 });
  assert.equal(stranger.ok, false);
  if (!stranger.ok) assert.equal(stranger.reason, "delisted");

  // The creator can — the whole point of unlisted.
  const res = await store.adoptListing("u-importer", listing.id, { maxSlots: 1 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.companion.kind, "adopted");
  assert.equal(res.companion.personaSource, "card_import");
  assert.equal((res.companion.importMeta as any).creator, "some-author");
  assert.equal(res.companion.adoptedFromListingId, listing.id);

  // Roster + DM resolve include the import.
  const roster = await store.listCompanionsForUser("u-importer");
  assert.equal(roster.length, 1);
  assert.equal(roster[0].id, res.companion.id);
  const picked = await store.resolveDmCompanion("u-importer");
  assert.equal(picked, null); // no pick yet + no awakened → nothing resolves
  await store.claimDmCompanionIfUnset("u-importer", res.companion.id);
  assert.equal((await store.resolveDmCompanion("u-importer"))?.id, res.companion.id);

  // Self-adopt doesn't move the public counter.
  const after = await store.listingById(listing.id);
  assert.equal(after!.addCount, 0);
});

test("unlisted rows stay out of the live-listing cap; publishListing flips + propagates", async () => {
  const { store } = await freshStore();
  // Two live listings already — free cap is 2.
  const c = await awakenedCompanion(store, "u-pub", "Pub");
  await makeListing(store, "u-pub", c.id, "Pub");
  const created1 = await store.createListing("u-pub", { ...IMPORT_SPEC, name: "I1" }, {});
  assert.equal(created1.ok, true);
  // Unlisted imports don't count toward the cap.
  const imp = await store.createListing("u-pub", { ...IMPORT_SPEC, name: "Imp" }, {
    status: "unlisted", personaSource: "card_import", importMeta: { sha256: "h1" },
  });
  assert.equal(imp.ok, true);
  if (!imp.ok) return;
  assert.equal(await store.activeListingCount("u-pub"), 2);

  // Adopt + publish.
  await store.adoptListing("u-pub", imp.listing.id, { maxSlots: 10 });
  const published = await store.publishListing(imp.listing.id, "u-pub", {
    ...IMPORT_SPEC, name: "Imp", tagline: "now public",
  }, 3);
  assert.equal(published.ok, true);
  if (!published.ok) return;
  assert.equal(published.listing.status, "active");
  assert.equal(published.listing.version, 2);
  assert.equal(published.listing.personaSource, "card_import");

  // Clone synced to the published persona.
  const roster = await store.listCompanionsForUser("u-pub");
  const clone = roster.find(x => x.adoptedFromListingId === imp.listing.id);
  assert.equal(clone?.name, "Imp");
  assert.equal(clone?.listingVersion, 2);
  assert.equal(await store.activeListingCount("u-pub"), 3);
});

test("publishListing enforces the live cap and refuses non-unlisted rows", async () => {
  const { store } = await freshStore();
  const c = await awakenedCompanion(store, "u-cap", "A");
  await makeListing(store, "u-cap", c.id, "A");
  const c2 = await awakenedCompanion(store, "u-cap2", "B");
  await makeListing(store, "u-cap2", c2.id, "B");
  const imp = await store.createListing("u-cap", { ...IMPORT_SPEC, name: "Imp" }, {
    status: "unlisted", personaSource: "card_import", importMeta: { sha256: "h2" },
  });
  assert.equal(imp.ok, true);
  if (!imp.ok) return;

  // u-cap already holds 1 live listing; cap=1 → publish refused.
  const blocked = await store.publishListing(imp.listing.id, "u-cap", { ...IMPORT_SPEC, name: "Imp" }, 1);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, "cap");

  // Active listings can't re-enter the path.
  const live = (await store.listMyListings("u-cap")).find(l => l.status === "active")!;
  const again = await store.publishListing(live.id, "u-cap", { ...IMPORT_SPEC }, 10);
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.reason, "not_unlisted");
});

test("findUnlistedByHash dedupes; deleteUnlistedListing only removes untouched rows", async () => {
  const { store } = await freshStore();
  const a = await store.createListing("u-d", { ...IMPORT_SPEC, name: "One" }, {
    status: "unlisted", personaSource: "card_import", importMeta: { sha256: "samehash" },
  });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal((await store.findUnlistedByHash("u-d", "samehash"))?.id, a.listing.id);
  assert.equal(await store.findUnlistedByHash("u-d", "other"), null);
  assert.equal(await store.findUnlistedByHash("u-other", "samehash"), null); // creator-scoped

  // Can't delete once adopted.
  await store.adoptListing("u-d", a.listing.id, { maxSlots: 5 });
  assert.equal(await store.deleteUnlistedListing(a.listing.id, "u-d"), false);

  // An un-adopted unlisted row deletes (persona_version row cascades).
  const b = await store.createListing("u-d", { ...IMPORT_SPEC, name: "Two" }, {
    status: "unlisted", personaSource: "card_import", importMeta: { sha256: "h3" },
  });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.equal(await store.deleteUnlistedListing(b.listing.id, "u-stranger"), false); // not yours
  assert.equal(await store.deleteUnlistedListing(b.listing.id, "u-d"), true);
  const vers = await sql`SELECT COUNT(*) AS n FROM companion_persona_versions WHERE listing_id = ${b.listing.id}`;
  assert.equal(Number(vers[0].n), 0);
});
