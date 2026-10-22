import assert from "node:assert/strict";
import test from "node:test";
import {
  esc, sitemapXml, listingIndexPage, listingPage, notFoundPage,
  fetchActiveListings, fetchListing, lookupListing, fetchListingRating, fetchRatingStats,
  relatedListings,
  fetchCreatorBySlug, fetchPublicCreator, fetchCreatorListings, fetchPublicCreators, creatorStats,
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
  greeting: "shh, welcome.", openings: [], loreCount: 0, avatarUrl: null, addCount: 12, updatedAt: "2026-04-02T10:00:00Z",
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

test("sitemap lists static pages plus live listing urls with lastmod", () => {
  const xml = sitemapXml([
    { id: 3, updatedAt: "2026-04-02T10:00:00+00:00" },
    { id: 4, updatedAt: "" },
  ]);
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/</loc>`));
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/characters</loc>`));
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/guides/import-character-cards</loc>`));
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/guides/leaving-character-ai</loc>`));
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

test("fetchListing maps openings from both the object and legacy string shapes", async () => {
  let seenUrl = "";
  await withFetch(
    async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify([{
        id: 9, name: "N", openings: [{ text: "  *a door opens*  " }, "plain string opening", { text: " " }, { nope: 1 }],
      }]));
    },
    async () => {
      const l = await fetchListing(ENV, 9);
      assert.deepEqual(l?.openings, ["*a door opens*", "plain string opening"], "objects unwrap, strings pass, blanks/junk drop");
    },
  );
  assert.ok(seenUrl.includes("openings"), "the column is in the PostgREST select");
});

test("fetchListing maps lorebook to a live-entry count — enabled:false stays shelved", async () => {
  let seenUrl = "";
  await withFetch(
    async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify([{
        id: 10, name: "N",
        lorebook: [
          { keys: ["a"], content: "one" },
          { keys: ["b"], content: "two", enabled: false },
          "a stray string shape still counts",
        ],
      }]));
    },
    async () => {
      const l = await fetchListing(ENV, 10);
      assert.equal(l?.loreCount, 2, "enabled:false entries don't count; other shapes do");
    },
  );
  assert.ok(seenUrl.includes("lorebook"), "the column is in the PostgREST select");
});

test("listing page shows the world-lore count — never the content or keys", () => {
  const html = listingPage(listing({ loreCount: 3 }), { avg: 0, count: 0 });
  assert.ok(html.includes("world lore · 3 entries"));
  const bare = listingPage(listing(), { avg: 0, count: 0 });
  assert.ok(!bare.includes("world lore"), "no lore → no stat line");
});

test("listing page renders 'More ways to meet' with every opening escaped", () => {
  const html = listingPage(listing({
    openings: ["*the door opens* <img src=x onerror='pwn'>", "a second <b>way</b>"],
  }), { avg: 0, count: 0 });
  assert.ok(html.includes("More ways to meet"));
  assert.ok(!html.includes("<img src=x"), "markup inside an opening is escaped");
  assert.ok(html.includes("&lt;img src=x"), "the escape is visible text, not swallowed");
  assert.ok(!html.includes("<b>way</b>"));

  const bare = listingPage(listing(), { avg: 0, count: 0 });
  assert.ok(!bare.includes("More ways to meet"), "no openings → no section");
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

test("lookupListing separates 'row absent' from 'upstream broken' — 404 vs 503", async () => {
  // hit
  await withFetch(
    async () => new Response(JSON.stringify([{ id: 8, name: "N" }])),
    async () => {
      const r = await lookupListing(ENV, 8);
      assert.equal(r.kind, "hit");
      if (r.kind === "hit") assert.equal(r.listing.id, 8);
    },
  );
  // miss: empty row set, or a malformed id that never reaches the network
  await withFetch(
    async () => new Response("[]"),
    async () => { assert.equal((await lookupListing(ENV, 404)).kind, "miss"); },
  );
  assert.equal((await lookupListing(ENV, -1)).kind, "miss");
  // error: HTTP failure, network failure, undecodable body, missing env — none
  // of these may masquerade as "gone" on a crawler-facing page.
  await withFetch(
    async () => new Response("boom", { status: 500 }),
    async () => { assert.equal((await lookupListing(ENV, 1)).kind, "error"); },
  );
  await withFetch(
    async () => { throw new Error("network down"); },
    async () => { assert.equal((await lookupListing(ENV, 1)).kind, "error"); },
  );
  await withFetch(
    async () => new Response("not json"),
    async () => { assert.equal((await lookupListing(ENV, 1)).kind, "error"); },
  );
  assert.equal((await lookupListing({}, 1)).kind, "error");
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

test("fetchRatingStats reads the GROUP BY view — one row per listing, not per rating", async () => {
  let seenUrl = "";
  await withFetch(
    async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify([
        { listing_id: 1, avg: 4, rating_count: 2 }, { listing_id: 2, avg: 4, rating_count: 1 },
      ]));
    },
    async () => {
      const m = await fetchRatingStats(ENV);
      assert.deepEqual(m.get(1), { avg: 4, count: 2 });
      assert.deepEqual(m.get(2), { avg: 4, count: 1 });
      assert.equal(m.get(99), undefined);
    },
  );
  assert.ok(seenUrl.includes("/rest/v1/listing_rating_stats"), seenUrl);
  assert.ok(!seenUrl.includes("/rest/v1/listing_ratings"), "raw rating rows must stay off the wire");
});

test("fetchListingRating maps the view row; no row or null avg → unrated", async () => {
  let seenUrl = "";
  await withFetch(
    async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify([{ avg: 4.5, rating_count: 3 }]));
    },
    async () => { assert.deepEqual(await fetchListingRating(ENV, 7), { avg: 4.5, count: 3 }); },
  );
  assert.ok(seenUrl.includes("listing_rating_stats"), seenUrl);
  assert.ok(seenUrl.includes("listing_id=eq.7"), seenUrl);
  for (const body of ["[]", JSON.stringify([{ avg: null, rating_count: 0 }])]) {
    await withFetch(
      async () => new Response(body),
      async () => { assert.deepEqual(await fetchListingRating(ENV, 7), { avg: 0, count: 0 }); },
    );
  }
});

// ── Creator profiles — opt-in public identity, banned creators 404 ──────────

const PUBLIC_CREATOR_ROW = {
  creator_slug: "night-forge", creator_name: "NightForge", creator_bio: "dark fantasy",
  discord_user_id: "d1", discord_avatar_url: null,
};

/** Routed fetch stub for the two-table creator lookups. */
const routedFetch = (routes: {
  profiles?: (url: string) => Response | Promise<Response>;
  bans?: (url: string) => Response | Promise<Response>;
  listings?: (url: string) => Response | Promise<Response>;
}, seen: string[] = []) =>
  async (input: string | URL | Request) => {
    const url = String((input as Request).url ?? input);
    seen.push(url);
    if (url.includes("marketplace_bans")) return routes.bans?.(url) ?? new Response("[]");
    if (url.includes("companion_listings")) return routes.listings?.(url) ?? new Response("[]");
    if (url.includes("web_profiles")) return routes.profiles?.(url) ?? new Response("[]");
    return new Response("unrouted " + url, { status: 500 });
  };

test("fetchCreatorBySlug filters creator_public at the boundary and joins bans", async () => {
  const seen: string[] = [];
  await withFetch(routedFetch({ profiles: () => new Response(JSON.stringify([PUBLIC_CREATOR_ROW])) }, seen), async () => {
    const r = await fetchCreatorBySlug(ENV, "night-forge");
    assert.equal(r.kind, "hit");
    if (r.kind === "hit") {
      assert.equal(r.creator.slug, "night-forge");
      assert.equal(r.creator.name, "NightForge");
      assert.equal(r.creator.creatorUserId, "d1", "join key resolved server-side");
    }
  });
  assert.ok(seen[0].includes("creator_public=eq.true"), seen[0]);
  assert.ok(seen[0].includes("creator_slug=eq.night-forge"), seen[0]);
  assert.ok(seen.some(u => u.includes("marketplace_bans") && u.includes("discord_user_id=eq.d1")), "ban check ran");
});

test("fetchCreatorBySlug — absent, private, unlinked and banned are all 'miss'", async () => {
  // absent / private: the public filter returns no row
  await withFetch(routedFetch({}), async () => {
    assert.equal((await fetchCreatorBySlug(ENV, "nobody")).kind, "miss");
  });
  // unlinked: row exists but carries no discord id
  await withFetch(routedFetch({
    profiles: () => new Response(JSON.stringify([{ ...PUBLIC_CREATOR_ROW, discord_user_id: null }])),
  }), async () => {
    assert.equal((await fetchCreatorBySlug(ENV, "night-forge")).kind, "miss");
  });
  // banned: the page is suppressed entirely
  await withFetch(routedFetch({
    profiles: () => new Response(JSON.stringify([PUBLIC_CREATOR_ROW])),
    bans: () => new Response(JSON.stringify([{ discord_user_id: "d1" }])),
  }), async () => {
    assert.equal((await fetchCreatorBySlug(ENV, "night-forge")).kind, "miss");
  });
});

test("fetchCreatorBySlug — upstream failures are 'error', never 'miss'", async () => {
  await withFetch(routedFetch({ profiles: () => new Response("boom", { status: 500 }) }), async () => {
    assert.equal((await fetchCreatorBySlug(ENV, "x")).kind, "error");
  });
  await withFetch(routedFetch({
    profiles: () => new Response(JSON.stringify([PUBLIC_CREATOR_ROW])),
    bans: () => new Response("boom", { status: 500 }),
  }), async () => {
    assert.equal((await fetchCreatorBySlug(ENV, "x")).kind, "error", "a broken ban check must not render the page");
  });
  await withFetch(routedFetch({ profiles: () => new Response("not json") }), async () => {
    assert.equal((await fetchCreatorBySlug(ENV, "x")).kind, "error");
  });
  assert.equal((await fetchCreatorBySlug({}, "x")).kind, "error");
});

test("fetchCreatorBySlug falls back to the slug when name is blank; bio is capped", async () => {
  await withFetch(routedFetch({
    profiles: () => new Response(JSON.stringify([{ ...PUBLIC_CREATOR_ROW, creator_name: "  ", creator_bio: "x".repeat(600) }])),
  }), async () => {
    const r = await fetchCreatorBySlug(ENV, "night-forge");
    assert.equal(r.kind, "hit");
    if (r.kind === "hit") {
      assert.equal(r.creator.name, "night-forge");
      assert.equal(r.creator.bio.length, 500);
    }
  });
});

test("fetchPublicCreator resolves the byline for public creators only", async () => {
  const seen: string[] = [];
  await withFetch(routedFetch({ profiles: () => new Response(JSON.stringify([PUBLIC_CREATOR_ROW])) }, seen), async () => {
    assert.deepEqual(await fetchPublicCreator(ENV, "d1"), { slug: "night-forge", name: "NightForge" });
  });
  assert.ok(seen[0].includes("creator_public=eq.true"), seen[0]);
  assert.ok(seen[0].includes("discord_user_id=eq.d1"), seen[0]);

  // private / unlinked / banned / upstream-broken → null byline (anonymous)
  await withFetch(routedFetch({}), async () => {
    assert.equal(await fetchPublicCreator(ENV, "d1"), null);
  });
  await withFetch(routedFetch({
    profiles: () => new Response(JSON.stringify([PUBLIC_CREATOR_ROW])),
    bans: () => new Response(JSON.stringify([{ discord_user_id: "d1" }])),
  }), async () => {
    assert.equal(await fetchPublicCreator(ENV, "d1"), null);
  });
  await withFetch(routedFetch({ profiles: () => new Response("boom", { status: 500 }) }), async () => {
    assert.equal(await fetchPublicCreator(ENV, "d1"), null);
  });
  assert.equal(await fetchPublicCreator(ENV, ""), null);
});

test("fetchCreatorListings is active-only, keyed by the internal discord id", async () => {
  const seen: string[] = [];
  await withFetch(routedFetch({
    listings: () => new Response(JSON.stringify([{
      id: 5, name: "W", tagline: "t", voice_persona: "v", core_traits: [], creator_tags: [],
      backstory: "b", greeting: "g", avatar_url: null, add_count: 2, updated_at: "",
    }])),
  }, seen), async () => {
    const rows = await fetchCreatorListings(ENV, "d1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 5);
  });
  assert.ok(seen[0].includes("status=eq.active"), seen[0]);
  assert.ok(seen[0].includes("creator_user_id=eq.d1"), seen[0]);
  // upstream failure → empty shelf, not a throw
  await withFetch(routedFetch({ listings: () => new Response("boom", { status: 500 }) }), async () => {
    assert.deepEqual(await fetchCreatorListings(ENV, "d1"), []);
  });
  assert.deepEqual(await fetchCreatorListings(ENV, ""), []);
});

test("fetchPublicCreators drops banned creators from the sitemap feed", async () => {
  const rows = [
    { creator_slug: "night-forge", discord_user_id: "d1", updated_at: "u1" },
    { creator_slug: "banned-one", discord_user_id: "d2", updated_at: "u2" },
    { creator_slug: null, discord_user_id: "d3", updated_at: "u3" },
  ];
  await withFetch(routedFetch({
    profiles: () => new Response(JSON.stringify(rows)),
    bans: () => new Response(JSON.stringify([{ discord_user_id: "d2" }])),
  }), async () => {
    const out = await fetchPublicCreators(ENV);
    assert.deepEqual(out, [{ slug: "night-forge", updatedAt: "u1" }]);
  });
  await withFetch(routedFetch({ profiles: () => new Response("boom", { status: 500 }) }), async () => {
    assert.deepEqual(await fetchPublicCreators(ENV), []);
  });
});

test("creatorStats weights the rating mean by count — never a mean of means", () => {
  const listings = [listing({ id: 1, addCount: 10 }), listing({ id: 2, addCount: 5 }), listing({ id: 3, addCount: 0 })];
  const ratings = new Map<number, { avg: number; count: number }>([
    [1, { avg: 4, count: 2 }],   // contributes 8
    [2, { avg: 5, count: 1 }],   // contributes 5
    // id 3 unrated — excluded entirely
  ]);
  assert.deepEqual(creatorStats(listings, ratings), {
    characters: 3, adoptions: 15, avgRating: 13 / 3, ratingCount: 3,
  });
  assert.deepEqual(creatorStats([], new Map()), { characters: 0, adoptions: 0, avgRating: null, ratingCount: 0 });
});

test("sitemapXml adds creator pages alongside static paths and listings", async () => {
  const xml = sitemapXml([{ id: 9, updatedAt: "2026-05-01" }], [{ slug: "night-forge", updatedAt: "2026-05-02" }]);
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/creators/night-forge</loc>`));
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/characters/9</loc>`));
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/</loc>`), "static paths kept");
  const bare = sitemapXml([{ id: 9, updatedAt: "" }]);
  assert.ok(!bare.includes("/creators/"), "no creators → no creator urls");
});
