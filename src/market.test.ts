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

function makeListing(store: MemoryStore, creatorId: string, sourceId: number, name = "Nyx") {
  return store.upsertListing(creatorId, sourceId, {
    name,
    tagline: "a very dry vampire",
    voicePersona: "dry, sharp",
    coreTraits: ["witty"],
    ownerDynamic: "protective friend",
    backstory: "old lore",
    greeting: "*looks up* …you again.",
    avatarUrl: null,
  });
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

  const v2 = await store.upsertListing("u-creator", companion.id, {
    name: "Nyx II",
    tagline: "drier than before",
    voicePersona: "drier",
    coreTraits: ["witty", "drier"],
    ownerDynamic: "protective friend",
    backstory: "older lore",
    greeting: "again?",
    avatarUrl: null,
  });
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

  const res = await store.adoptListing("u-adopter", listing.id, 1, COOLDOWN);
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
  const again = await store.adoptListing("u-adopter", listing.id, 1, COOLDOWN);
  assert.equal(again.ok, true);
  if (again.ok) {
    assert.equal(again.reused, true);
    assert.equal(again.companion.id, res.companion.id);
  }

  // Creator's own listing can't be adopted by them.
  const own = await store.adoptListing("u-creator2", listing.id, 10, COOLDOWN);
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
  const first = await store.adoptListing("u-free", listing.id, 1, COOLDOWN);
  assert.equal(first.ok, true);
  const second = await store.adoptListing("u-free", listing2.id, 1, COOLDOWN);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "cap");

  // premium: effectively uncapped (caller passes a huge ceiling)
  const p1 = await store.adoptListing("u-premium", listing.id, Number.MAX_SAFE_INTEGER, COOLDOWN);
  const p2 = await store.adoptListing("u-premium", listing2.id, Number.MAX_SAFE_INTEGER, COOLDOWN);
  assert.equal(p1.ok, true);
  assert.equal(p2.ok, true);
});

test("drop frees the slot, starts a 12h cooldown, re-adopt reuses the clone", async () => {
  const { store } = await freshStore();
  const creator = await awakenedCompanion(store, "u-c5", "Ash");
  const listing = await makeListing(store, "u-c5", creator.id, "Ash");
  const first = await store.adoptListing("u-dropper", listing.id, 1, COOLDOWN);
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
  const blocked = await store.adoptListing("u-dropper", listing.id, 1, COOLDOWN);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, "cooldown");

  // …and once it expires, re-adopting reuses the same clone + relationship.
  await sql`UPDATE companion_adoptions SET cooldown_until = NOW() - INTERVAL '1 minute' WHERE id = ${dropped!.id}`;
  const reAdopt = await store.adoptListing("u-dropper", listing.id, 1, COOLDOWN);
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
  const adopted = await store.adoptListing("u-picker", listing.id, 1, COOLDOWN);
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
  const adopt = await store.adoptListing("u-ad7", listing.id, 1, COOLDOWN);
  assert.equal(adopt.ok, true);
  if (!adopt.ok) return;

  await store.summonCompanion("g7", adopt.companion.id, "u-ad7", "ad7");

  await store.upsertListing("u-c7", creator.id, {
    name: "New Name",
    tagline: "new tag",
    voicePersona: "new voice",
    coreTraits: ["new"],
    ownerDynamic: "new bond",
    backstory: "new lore",
    greeting: "hi v2",
    avatarUrl: null,
  });

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

  assert.equal(await store.reportListing(listing.id, "u-r1"), 1);
  assert.equal(await store.reportListing(listing.id, "u-r1"), -1); // dup
  assert.equal(await store.reportListing(listing.id, "u-r2"), 2);

  await store.flagListing(listing.id);
  const blocked = await store.adoptListing("u-r3", listing.id, 1, COOLDOWN);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, "delisted");

  await store.delistListing(listing.id);
  assert.equal((await store.listingById(listing.id))!.status, "delisted");
});

test("markDmIntroduced stamps the adoption; roster lists awakened then adopted", async () => {
  const { store } = await freshStore();
  const awakened = await awakenedCompanion(store, "u-i", "Main");
  const creator = await awakenedCompanion(store, "u-c9", "Side");
  const listing = await makeListing(store, "u-c9", creator.id, "Side");
  const adopt = await store.adoptListing("u-i", listing.id, 1, COOLDOWN);
  assert.equal(adopt.ok, true);
  if (!adopt.ok) return;

  assert.equal(adopt.adoption.dmIntroducedAt, null);
  await store.markDmIntroduced(adopt.adoption.id);
  const after = await store.adoptionForCompanion(adopt.companion.id);
  assert.ok(after!.dmIntroducedAt);

  const roster = await store.listCompanionsForUser("u-i");
  assert.deepEqual(roster.map(c => c.id), [awakened.id, adopt.companion.id]);
});
