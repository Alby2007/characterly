// Shelf data for the server-rendered /characters routes. The PostgREST layer
// (active-only filter, degrade-to-empty, rating view) stays single-source in
// the bot's src/site-shelf.ts, which its test suite covers; this module adds
// the per-isolate catalog cache and server env wiring.
import { env } from "cloudflare:workers";
import {
  fetchActiveListings, fetchListing, fetchListingRating, fetchRatingStats, relatedListings,
  type ShelfListing, type ShelfRating,
} from "../../../src/site-shelf.ts";

export type { ShelfListing, ShelfRating };

const shelfEnv = () => ({
  SUPABASE_URL: (env as Record<string, string | undefined>).SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: (env as Record<string, string | undefined>).SUPABASE_SERVICE_ROLE_KEY,
});

// Matches the edge cache window (s-maxage=300): a delist surfaces within five
// minutes either way. FIX: character pages no longer refetch the whole active
// catalog on every request just to compute "More like this".
const CATALOG_TTL_MS = 5 * 60 * 1000;
let catalog: { at: number; listings: ShelfListing[]; ratings: Map<number, ShelfRating> } | null = null;

// Local development without the service-role secret: show the first-party seed
// roster so pages can be checked with content. Never in a production build
// (import.meta.env.DEV is false there and this branch is dropped).
async function devFixture(): Promise<{ listings: ShelfListing[]; ratings: Map<number, ShelfRating> } | null> {
  if (!import.meta.env.DEV || shelfEnv().SUPABASE_SERVICE_ROLE_KEY) return null;
  const { SEED_LISTINGS } = await import("../../../src/seed-personas.ts");
  const listings = SEED_LISTINGS.map((s, i) => ({
    id: i + 1, name: s.name, tagline: s.tagline, voicePersona: s.voicePersona, coreTraits: s.coreTraits,
    creatorTags: s.tags, backstory: s.backstory, greeting: s.greeting,
    avatarUrl: null, addCount: Math.max(0, 40 - i * 3), updatedAt: "2026-10-01",
  }));
  return { listings, ratings: new Map([[1, { avg: 4.6, count: 12 }]]) };
}

export async function getCatalog() {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog;
  const fixture = await devFixture();
  if (fixture) return { at: Date.now(), ...fixture };
  const [listings, ratings] = await Promise.all([fetchActiveListings(shelfEnv()), fetchRatingStats(shelfEnv())]);
  // Never cache an empty read: it is far more likely an outage than an empty shelf.
  if (listings.length) catalog = { at: Date.now(), listings, ratings };
  return { at: Date.now(), listings, ratings };
}

export async function getListingPage(id: number) {
  const fixture = await devFixture();
  if (fixture) {
    const listing = fixture.listings.find(l => l.id === id);
    return listing ? { listing, rating: fixture.ratings.get(id) ?? { avg: 0, count: 0 }, related: relatedListings(listing, fixture.listings), ratings: fixture.ratings } : null;
  }
  // The listing itself is always read fresh, so a delist 404s immediately.
  const [listing, rating, cat] = await Promise.all([
    fetchListing(shelfEnv(), id), fetchListingRating(shelfEnv(), id), getCatalog(),
  ]);
  if (!listing) return null;
  return { listing, rating, related: relatedListings(listing, cat.listings), ratings: cat.ratings };
}

export const SHELF_CACHE = "public, max-age=60, s-maxage=300";

export const ratingLabel = (r: ShelfRating | undefined): string | null =>
  r && r.count > 0 ? `Rated ${r.avg.toFixed(1)} (${r.count} ${r.count === 1 ? "rating" : "ratings"})` : null;

export const addsLabel = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "adoption" : "adoptions"}`;

export const initial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();
