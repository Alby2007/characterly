import assert from "node:assert/strict";
import test from "node:test";
import {
  esc, sitemapXml, listingIndexPage, listingPage, notFoundPage,
  fetchActiveListings, fetchListing, fetchListingRating, fetchRatingStats,
  relatedListings, importGuidePage,
  SITE_ORIGIN, type ShelfListing,
} from "./site-shelf.js";

// The shelf is the marketplace's indexable surface — its contract is:
//   1. every user-authored string is HTML-escaped (publish screening is not
//      output encoding),
//   2. only status='active' rows ever reach a template (the filter lives at
//      the PostgREST boundary, not in the page), and
//   3. gone listings 404 hard so they drop out of the index.

const listing = (over: Partial<ShelfListing> = {}): ShelfListing => ({
  id: 7, name: "Wren", tagline: "A quiet archivist", voicePersona: "speaks softly",
  coreTraits: ["patient"], creatorTags: ["original"], backstory: "keeps the stacks",
  greeting: "shh, welcome.", avatarUrl: null, addCount: 12, updatedAt: "2026-04-02T10:00:00Z",
  ...over,
});

// ── esc() — the output-encoding contract ────────────────────────────────────

test("esc neutralizes markup, quotes and ampersands", () => {
  assert.equal(
    esc(`<img src=x onerror="alert('pwn')"> & "quoted"`),
    "&lt;img src=x onerror=&quot;alert(&#39;pwn&#39;)&quot;&gt; &amp; &quot;quoted&quot;",
  );
});

// ── Templates ────────────────────────────────────────────────────────────────

test("index page escapes hostile listing fields everywhere they render", () => {
  const html = listingIndexPage([listing({
    name: `<script>alert(1)</script>`,
    tagline: `"><img onerror="x">`,
    creatorTags: [`<b>nsfw</b>`],
  })], new Map());
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes(`"><img onerror="x">`));
  assert.ok(!html.includes("<b>nsfw</b>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("index page emits ItemList with canonical listing urls", () => {
  const html = listingIndexPage([listing({ id: 3 }), listing({ id: 4 })], new Map());
  assert.ok(html.includes('"@type":"ItemList"'));
  assert.ok(html.includes(`"url":"${SITE_ORIGIN}/characters/3"`));
  assert.ok(html.includes('href="/characters/3"'));
  assert.ok(html.includes('href="/characters/4"'));
  assert.ok(html.includes(`<link rel="canonical" href="${SITE_ORIGIN}/characters"`));
});

test("index page renders an empty state when nothing is published", () => {
  const html = listingIndexPage([], new Map());
  assert.ok(html.includes("Nothing on the shelf"));
  assert.ok(!html.includes('"itemListElement":[]') || html.includes('"@type":"ItemList"'));
});

test("listing page escapes name, backstory and greeting", () => {
  const html = listingPage(listing({
    name: `</title><svg onload=x>`,
    backstory: `line1\nline2 <iframe src=evil>`,
    greeting: `"<b>hi</b>"`,
  }), { avg: 4.5, count: 2 });
  // JSON-LD is raw text — markup inside it is inert data (only </script> can
  // break out, which jsonLd() neutralizes; tested separately below). Assert
  // against the rendered surface: everything outside the ld+json blocks.
  const visible = html.replace(/<script type="application\/ld\+json">.*?<\/script>/gs, "");
  assert.ok(!visible.includes("<svg onload=x>"));
  assert.ok(!visible.includes("<iframe src=evil>"));
  assert.ok(!visible.includes("<b>hi</b>"));
  assert.ok(visible.includes("&lt;svg onload=x&gt;"));
  // multi-line backstory renders as <br>, still escaped
  assert.ok(visible.includes("line1<br>line2 &lt;iframe src=evil&gt;"));
});

test("listing page emits aggregateRating only when the count is real", () => {
  const withRating = listingPage(listing(), { avg: 4.5, count: 3 });
  assert.ok(withRating.includes('"@type":"Product"'), "Product — the review-snippet eligible type");
  assert.ok(withRating.includes('"@type":"AggregateRating"'));
  assert.ok(withRating.includes('"ratingValue":"4.5"'));
  assert.ok(withRating.includes('"ratingCount":3'));
  assert.ok(withRating.includes('"@type":"Offer"'), "a $0 offer keeps the Product honest");
  const noRating = listingPage(listing(), { avg: 0, count: 0 });
  assert.ok(!noRating.includes("aggregateRating"));
});

test("listing page title and description carry the searchable phrase", () => {
  const html = listingPage(listing({ name: "Wren", coreTraits: ["patient", "wry"] }), { avg: 0, count: 0 });
  assert.ok(html.includes("<title>Wren, an AI companion for Discord · Characterly</title>"));
  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
  assert.ok(desc.includes("quiet archivist"), "tagline leads");
  assert.ok(desc.includes("patient"), "traits follow");
  assert.ok(desc.includes("Discord"), "platform named");
});

test("listing page carries breadcrumbs, canonical and no creator identity", () => {
  const html = listingPage(listing({ id: 9 }), { avg: 0, count: 0 });
  assert.ok(html.includes('"@type":"BreadcrumbList"'));
  assert.ok(html.includes(`<link rel="canonical" href="${SITE_ORIGIN}/characters/9"`));
  assert.ok(html.includes("a community creator")); // attribution, never a snowflake
  assert.ok(!html.includes("creatorUserId"));
  assert.ok(html.includes('name="twitter:title"'), "twitter card fields present");
});

test("relatedListings ranks shared tags above traits, adoptions as tiebreak", () => {
  const self = listing({ id: 1, creatorTags: ["mystery"], coreTraits: ["deadpan"] });
  const tagMatch = listing({ id: 2, name: "B", creatorTags: ["mystery"], coreTraits: [] });
  const traitMatch = listing({ id: 3, name: "C", creatorTags: [], coreTraits: ["deadpan"] });
  const bothMatch = listing({ id: 4, name: "D", creatorTags: ["mystery"], coreTraits: ["deadpan"] });
  const unrelated = listing({ id: 5, name: "E", creatorTags: ["romance"], coreTraits: ["warm"] });
  const rel = relatedListings(self, [self, traitMatch, tagMatch, bothMatch, unrelated]);
  assert.deepEqual(rel.map(r => r.id), [4, 2, 3]);
  assert.ok(!rel.includes(self), "never relates to itself");
  assert.ok(!rel.includes(unrelated), "score-0 listings excluded");
});

test("listing page renders More like this links to related listings", () => {
  const related = [listing({ id: 22, name: "Iris" })];
  const html = listingPage(listing({ id: 9 }), { avg: 0, count: 0 }, related);
  assert.ok(html.includes("More like this"));
  assert.ok(html.includes('href="/characters/22"'));
  const none = listingPage(listing({ id: 9 }), { avg: 0, count: 0 }, []);
  assert.ok(!none.includes("More like this"), "section hidden with no related");
});

test("json-ld blocks cannot be broken out of with </script>", () => {
  const html = listingPage(listing({ name: `</script><script>alert(1)` }), { avg: 0, count: 0 });
  const ldBlocks = html.split(`<script type="application/ld+json">`).slice(1);
  assert.ok(ldBlocks.length >= 2);
  for (const b of ldBlocks) {
    const payload = b.split("</script>")[0];
    assert.ok(!payload.includes("</script>"));
  }
});

test("notFoundPage is a real shelf-shaped 404", () => {
  const html = notFoundPage();
  assert.ok(html.includes("Off the shelf"));
  assert.ok(html.includes('href="/characters"'));
});

// ── Sitemap ──────────────────────────────────────────────────────────────────

test("import guide renders the migration-intent page", () => {
  const html = importGuidePage();
  assert.ok(html.includes("Import a character card into Discord"));
  assert.ok(html.includes("/companion import"));
  assert.ok(html.includes("discord.gg"), "join CTA present");
  assert.ok(html.includes('href="/characters"'), "links back to the shelf");
});

test("sitemap lists static pages plus live listing urls with lastmod", () => {
  const xml = sitemapXml([
    { id: 3, updatedAt: "2026-04-02T10:00:00+00:00" },
    { id: 4, updatedAt: "" },
  ]);
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/</loc>`));
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/characters</loc>`));
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/guides/import-character-cards</loc>`));
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/safety</loc>`));
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/characters/3</loc>`));
  assert.ok(xml.includes("<lastmod>2026-04-02</lastmod>"));
  assert.ok(!xml.includes("characters/4</loc>\n    <lastmod>"), "missing updatedAt → no lastmod");
  assert.ok(xml.startsWith(`<?xml version="1.0"`));
});

// ── PostgREST boundary — active-only is a query filter, not a template check ──

const ENV = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" };

function withFetch(fn: (input: string | URL | Request) => Promise<Response>, run: () => Promise<void>) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  return run().finally(() => { globalThis.fetch = orig; });
}

test("fetchActiveListings filters status=eq.active at the query boundary", async () => {
  let seenUrl = "";
  await withFetch(
    async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify([{
        id: 5, name: "W", tagline: "t", voice_persona: "v", core_traits: ["a"],
        creator_tags: ["x"], backstory: "b", greeting: "g", avatar_url: null,
        add_count: 2, updated_at: "2026-01-01",
      }]));
    },
    async () => {
      const rows = await fetchActiveListings(ENV);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 5);
      assert.equal(rows[0].voicePersona, "v");
      assert.deepEqual(rows[0].creatorTags, ["x"]);
    },
  );
  assert.ok(seenUrl.includes("status=eq.active"), seenUrl);
  assert.ok(seenUrl.includes("/rest/v1/companion_listings"), seenUrl);
});

test("fetchListing asks PostgREST for the active row and maps it", async () => {
  let seenUrl = "";
  await withFetch(
    async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify([{ id: 8, name: "N", tagline: "", voice_persona: "", core_traits: [], creator_tags: [], backstory: "", greeting: "", avatar_url: null, add_count: 0, updated_at: "" }]));
    },
    async () => {
      const l = await fetchListing(ENV, 8);
      assert.equal(l?.id, 8);
    },
  );
  assert.ok(seenUrl.includes("status=eq.active"), seenUrl);
  assert.ok(seenUrl.includes("id=eq.8"), seenUrl);
});

test("fetchListing returns null for a delisted/unknown id (the row never arrives)", async () => {
  await withFetch(
    async () => new Response("[]"),
    async () => { assert.equal(await fetchListing(ENV, 404), null); },
  );
  // A non-integer/absurd id never reaches the network at all.
  assert.equal(await fetchListing(ENV, -1), null);
  assert.equal(await fetchListing(ENV, NaN), null);
});

test("fetch helpers degrade to empty/null on failure — the shelf never 500s", async () => {
  await withFetch(
    async () => new Response("boom", { status: 500 }),
    async () => {
      assert.deepEqual(await fetchActiveListings(ENV), []);
      assert.equal(await fetchListing(ENV, 1), null);
      assert.deepEqual(await fetchListingRating(ENV, 1), { avg: 0, count: 0 });
      assert.deepEqual(await fetchRatingStats(ENV), new Map());
    },
  );
  await withFetch(
    async () => { throw new Error("network down"); },
    async () => { assert.deepEqual(await fetchActiveListings(ENV), []); },
  );
  // Missing env → silent empty shelf (self-hosters without the service key).
  assert.deepEqual(await fetchActiveListings({}), []);
});

test("fetchRatingStats aggregates per listing", async () => {
  await withFetch(
    async () => new Response(JSON.stringify([
      { listing_id: 1, stars: 5 }, { listing_id: 1, stars: 3 }, { listing_id: 2, stars: 4 },
    ])),
    async () => {
      const m = await fetchRatingStats(ENV);
      assert.deepEqual(m.get(1), { avg: 4, count: 2 });
      assert.deepEqual(m.get(2), { avg: 4, count: 1 });
      assert.equal(m.get(99), undefined);
    },
  );
});
