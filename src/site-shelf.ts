// Public, worker-rendered shelf — /characters, /characters/<id>, /sitemap.xml.
// The marketplace's indexable surface: every listing shown here passed
// status='active' (published, unflagged, unbanned, listed) — the same gate the
// Discord shelf shows. Lives in src/ so the backend test suite exercises the
// templates; the website worker imports it for its routes.
//
// SECURITY CONTRACT: every interpolated listing field passes esc() — names,
// backstories, greetings and traits are user-authored. Publish-time screening
// is not a substitute for output encoding on a first-party domain.

/** Server invite — mirrors web/src/lib/config.ts LINKS.discord. Keep in sync
 *  (this module is plain TS, not an Astro page, so it can't import the site
 *  config). */
export const DISCORD_INVITE = "https://discord.gg/tNGCeaTPtC";
export const SITE_ORIGIN = "https://characterly.app";

export type ShelfListing = {
  id: number;
  name: string;
  tagline: string;
  voicePersona: string;
  coreTraits: string[];
  creatorTags: string[];
  backstory: string;
  greeting: string;
  /** Alternate openings (v68) — text-only projection; the column's
   *  {text,label?,premise?} objects flatten to their text for display. */
  openings: string[];
  avatarUrl: string | null;
  addCount: number;
  updatedAt: string;
};

export type ShelfRating = { avg: number; count: number };

export interface ShelfEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const escAttr = esc; // same escaping covers attribute positions

// ── PostgREST ───────────────────────────────────────────────────────────────

type RawListing = {
  id: number; name: string; tagline: string; voice_persona: string;
  core_traits: string[]; creator_tags: string[]; backstory: string;
  greeting: string; openings: unknown; avatar_url: string | null; add_count: number; updated_at: string;
};

const LISTING_SELECT = "id,name,tagline,voice_persona,core_traits,creator_tags,backstory,greeting,openings,avatar_url,add_count,updated_at";

function restBase(env: ShelfEnv): { base: string; headers: Record<string, string> } | null {
  const base = env.SUPABASE_URL?.replace(/\/+$/, "");
  if (!base || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return {
    base,
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  };
}

/** avatar_url renders into <img src>, og:image and JSON-LD on first-party
 *  pages. javascript:/data:/blob: schemes are inert markup-wise under CSP but
 *  junk for unfurlers — and a future sink could forget the constraint. Only
 *  http(s) and same-origin absolute paths render. */
const safeAvatarUrl = (u: string | null): string | null =>
  u != null && (/^https?:\/\//i.test(u) || /^\/(?!\/)/.test(u)) ? u : null;

/** openings jsonb tolerates both the [{text}] object shape and plain
 *  strings (hand-written fixtures) — the shelf only ever needs the text. */
const openingTexts = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.slice(0, 4).flatMap(o => {
        const t = (typeof o === "string" ? o : String((o as { text?: unknown })?.text ?? "")).trim().slice(0, 1000);
        return t ? [t] : [];
      })
    : [];

const toListing = (r: RawListing): ShelfListing => ({
  id: r.id, name: r.name ?? "", tagline: r.tagline ?? "", voicePersona: r.voice_persona ?? "",
  coreTraits: r.core_traits ?? [], creatorTags: r.creator_tags ?? [],
  backstory: r.backstory ?? "", greeting: r.greeting ?? "",
  openings: openingTexts(r.openings),
  avatarUrl: safeAvatarUrl(r.avatar_url), addCount: r.add_count ?? 0, updatedAt: r.updated_at ?? "",
});

/** Published listings, most-adopted first. Only status='active' — delisted,
 *  flagged, banned and unlisted rows never render publicly. Read failures
 *  degrade to an empty shelf, never a 500 — the page must not die with the
 *  database. */
export async function fetchActiveListings(env: ShelfEnv): Promise<ShelfListing[]> {
  const rest = restBase(env);
  if (!rest) return [];
  const res = await fetch(`${rest.base}/rest/v1/companion_listings?select=${LISTING_SELECT}&status=eq.active&order=add_count.desc`, { headers: rest.headers }).catch(() => null);
  if (!res?.ok) return [];
  const rows = (await res.json().catch(() => [])) as RawListing[];
  return Array.isArray(rows) ? rows.map(toListing) : [];
}

/** fetchListing with the absent-vs-broken split intact. A crawler-facing
 *  detail page needs a real "row absent" to serve a real 404 — upstream
 *  failures must answer 503 instead, or a PostgREST blip reads as a delist
 *  and live pages drop out of the index during an outage. */
export type ListingLookup =
  | { kind: "hit"; listing: ShelfListing }
  | { kind: "miss" }
  | { kind: "error" };

export async function lookupListing(env: ShelfEnv, id: number): Promise<ListingLookup> {
  if (!Number.isInteger(id) || id <= 0) return { kind: "miss" };
  const rest = restBase(env);
  if (!rest) return { kind: "error" };
  const res = await fetch(`${rest.base}/rest/v1/companion_listings?select=${LISTING_SELECT}&status=eq.active&id=eq.${id}&limit=1`, { headers: rest.headers }).catch(() => null);
  if (!res?.ok) return { kind: "error" };
  const rows = (await res.json().catch(() => null)) as RawListing[] | null;
  if (!Array.isArray(rows)) return { kind: "error" };
  return rows[0] ? { kind: "hit", listing: toListing(rows[0]) } : { kind: "miss" };
}

export async function fetchListing(env: ShelfEnv, id: number): Promise<ShelfListing | null> {
  const r = await lookupListing(env, id);
  return r.kind === "hit" ? r.listing : null;
}

export async function fetchListingRating(env: ShelfEnv, listingId: number): Promise<ShelfRating> {
  const rest = restBase(env);
  if (!rest) return { avg: 0, count: 0 };
  // listing_rating_stats is a GROUP BY view (v64) — one row back regardless
  // of how many rating rows the table holds.
  const res = await fetch(`${rest.base}/rest/v1/listing_rating_stats?select=avg,rating_count&listing_id=eq.${listingId}`, { headers: rest.headers }).catch(() => null);
  if (!res?.ok) return { avg: 0, count: 0 };
  const rows = (await res.json().catch(() => [])) as Array<{ avg: number | null; rating_count: number }>;
  const row = rows[0];
  if (!row || row.avg == null) return { avg: 0, count: 0 };
  return { avg: Number(row.avg), count: Number(row.rating_count) };
}

/** All rating stats in one query — the index renders every card's stars.
 *  The view returns one row per rated listing, not per rating. */
export async function fetchRatingStats(env: ShelfEnv): Promise<Map<number, ShelfRating>> {
  const rest = restBase(env);
  const out = new Map<number, ShelfRating>();
  if (!rest) return out;
  const res = await fetch(`${rest.base}/rest/v1/listing_rating_stats?select=listing_id,avg,rating_count`, { headers: rest.headers }).catch(() => null);
  if (!res?.ok) return out;
  const rows = (await res.json().catch(() => [])) as Array<{ listing_id: number; avg: number | null; rating_count: number }>;
  if (!Array.isArray(rows)) return out;
  for (const r of rows) if (r.avg != null) out.set(r.listing_id, { avg: Number(r.avg), count: Number(r.rating_count) });
  return out;
}

// ── Templates ───────────────────────────────────────────────────────────────

/** JSON-LD is data, not markup — stringify then neutralize `</script` so a
 *  crafted string can't break out of the block. */
const jsonLd = (data: unknown): string =>
  `<script type="application/ld+json">${JSON.stringify(data).replace(/<\//g, "<\\/")}</script>`;

const nl2br = (s: string): string => esc(s).replace(/\n/g, "<br>");

function shell(opts: {
  title: string;
  description: string;
  canonical: string;
  ogImage?: string | null;
  ogType?: string;
  jsonLd?: unknown[];
  body: string;
}): string {
  const ogImage = opts.ogImage ?? `${SITE_ORIGIN}/og.png`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escAttr(opts.title)}</title>
  <meta name="description" content="${escAttr(opts.description)}" />
  <meta name="theme-color" content="#0d0a0e" />
  <meta property="og:title" content="${escAttr(opts.title)}" />
  <meta property="og:description" content="${escAttr(opts.description)}" />
  <meta property="og:type" content="${opts.ogType ?? "website"}" />
  <meta property="og:site_name" content="Characterly" />
  <meta property="og:url" content="${escAttr(opts.canonical)}" />
  <meta property="og:image" content="${escAttr(ogImage)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escAttr(opts.title)}" />
  <meta name="twitter:description" content="${escAttr(opts.description)}" />
  <meta name="twitter:image" content="${escAttr(ogImage)}" />
  <link rel="canonical" href="${escAttr(opts.canonical)}" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="stylesheet" href="/shelf.css" />
</head>
<body>
  <header class="nav"><div class="nav-inner">
    <a class="brand" href="/"><img src="/mark.svg" alt="" width="26" height="26" /><span>Characterly</span></a>
    <nav class="nav-links"><a href="/characters">The shelf</a><a href="/#how">How it works</a><a href="/#faq">FAQ</a><a href="/safety">Safety</a></nav>
    <a class="btn" href="${DISCORD_INVITE}" target="_blank" rel="noopener noreferrer">Join the server</a>
  </div></header>
  <main>
${opts.body}
  </main>
  <footer class="foot">
    <span>Characterly — companions inside Discord.</span>
    <nav><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security">Security</a><a href="/safety">Safety</a></nav>
  </footer>
  ${(opts.jsonLd ?? []).map(jsonLd).join("\n  ")}
</body>
</html>`;
}

const ratingText = (r: ShelfRating | undefined): string =>
  r && r.count > 0 ? `★ ${r.avg.toFixed(1)} (${r.count})` : "unrated";

function listingCard(l: ShelfListing, rating: ShelfRating | undefined): string {
  const avatar = l.avatarUrl
    ? `<img class="card-av" src="${escAttr(l.avatarUrl)}" alt="${escAttr(l.name)}" loading="lazy" />`
    : `<span class="card-av card-av-ph" aria-hidden="true">${escAttr((l.name.trim()[0] ?? "?").toUpperCase())}</span>`;
  const tags = l.creatorTags.slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join("");
  return `      <a class="card" href="/characters/${l.id}">
        ${avatar}
        <span class="card-body">
          <span class="card-name">${esc(l.name)}</span>
          <span class="card-tag">${esc(l.tagline)}</span>
          <span class="card-meta">${tags}${ratingText(rating)} · ${l.addCount} ${l.addCount === 1 ? "adoption" : "adoptions"}</span>
        </span>
      </a>`;
}

/** /characters — the public shelf index. ItemList schema gives Google the
 *  whole catalog in one page. The visible h1 keeps the site's voice; the
 *  <title> and copy carry the keywords a searcher's query actually uses. */
export function listingIndexPage(listings: ShelfListing[], ratings: Map<number, ShelfRating>): string {
  const cards = listings.map(l => listingCard(l, ratings.get(l.id))).join("\n");
  const itemList = {
    "@context": "https://schema.org", "@type": "ItemList",
    itemListElement: listings.map((l, i) => ({
      "@type": "ListItem", position: i + 1, url: `${SITE_ORIGIN}/characters/${l.id}`, name: l.name,
    })),
  };
  return shell({
    title: "The shelf — AI companions for Discord · Characterly",
    description: "Browse community-published AI companions for Discord — adopt one into a private thread, and it remembers you and follows you into your servers.",
    canonical: `${SITE_ORIGIN}/characters`,
    jsonLd: [itemList],
    body: `    <section class="shelf">
      <p class="label">The marketplace</p>
      <h1>The shelf.</h1>
      <p class="lede">Every companion here is a character someone in the community designed and published — an AI companion you can adopt into a private Discord thread. Each one keeps its own inspectable memory of you, lives in your DMs, and can follow you into your own servers.</p>
      <p class="lede">Adoption happens inside <a href="${DISCORD_INVITE}" target="_blank" rel="noopener noreferrer">the Characterly server</a>: pick a character, start a thread, and it remembers you from the first hello. Want to publish your own? <a href="/guides/import-character-cards">Import a character card</a> and it's on the shelf in minutes.</p>
      ${listings.length ? `<div class="grid">\n${cards}\n      </div>` : `<p class="lede dim">Nothing on the shelf yet — be the first to publish.</p>`}
    </section>`,
  });
}

/** Other listings most like this one — shared creator tags weigh twice
 *  (creators tag deliberately), shared core traits once, adoption count as
 *  the tiebreak. Feeds the "More like this" block: internal links are how
 *  crawlers map the catalog and how visitors keep browsing. */
export function relatedListings(l: ShelfListing, all: ShelfListing[], n = 4): ShelfListing[] {
  return all
    .filter(o => o.id !== l.id)
    .map(o => ({
      o,
      score: o.creatorTags.filter(t => l.creatorTags.includes(t)).length * 2
        + o.coreTraits.filter(t => l.coreTraits.includes(t)).length,
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.o.addCount - a.o.addCount)
    .slice(0, n)
    .map(x => x.o);
}

/** /characters/<id> — one indexable page per published listing. Product
 *  schema (a listing is an adoptable item with a $0 offer — the documented
 *  path for review snippets; CreativeWork doesn't earn them) plus
 *  BreadcrumbList. aggregateRating only with a real rating count. */
export function listingPage(l: ShelfListing, rating: ShelfRating, related: ShelfListing[] = []): string {
  const canonical = `${SITE_ORIGIN}/characters/${l.id}`;
  const title = `${l.name}, an AI companion for Discord · Characterly`;
  const traitLine = l.coreTraits.length ? ` Traits: ${l.coreTraits.slice(0, 5).join(", ")}.` : "";
  const description = `${l.tagline ? `${l.tagline}.` : `${l.name} is a community AI companion on the Characterly shelf.`}${traitLine} Adopt ${l.name} into a private Discord thread — it remembers you from the first hello.`;
  const traits = l.coreTraits.slice(0, 6).map(t => `<span class="tag">${esc(t)}</span>`).join("");
  const tags = l.creatorTags.slice(0, 4).map(t => `<span class="tag tag-dim">${esc(t)}</span>`).join("");
  const product: Record<string, unknown> = {
    "@context": "https://schema.org", "@type": "Product",
    name: l.name, description, url: canonical,
    ...(l.avatarUrl ? { image: l.avatarUrl } : {}),
    brand: { "@type": "Organization", name: "Characterly community" },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD", availability: "https://schema.org/InStock", url: canonical },
    ...(rating.count > 0 ? {
      aggregateRating: { "@type": "AggregateRating", ratingValue: rating.avg.toFixed(1), ratingCount: rating.count },
    } : {}),
  };
  const crumbs = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_ORIGIN}/` },
      { "@type": "ListItem", position: 2, name: "The shelf", item: `${SITE_ORIGIN}/characters` },
      { "@type": "ListItem", position: 3, name: l.name },
    ],
  };
  return shell({
    title, description, canonical,
    ogImage: l.avatarUrl,
    jsonLd: [product, crumbs],
    body: `    <article class="listing">
      <nav class="crumbs"><a href="/">Home</a> / <a href="/characters">The shelf</a> / ${esc(l.name)}</nav>
      <div class="listing-head">
        ${l.avatarUrl
          ? `<img class="listing-av" src="${escAttr(l.avatarUrl)}" alt="${escAttr(l.name)}" />`
          : `<span class="listing-av card-av-ph" aria-hidden="true">${escAttr((l.name.trim()[0] ?? "?").toUpperCase())}</span>`}
        <div>
          <h1>${esc(l.name)}</h1>
          ${l.tagline ? `<p class="lede">${esc(l.tagline)}</p>` : ""}
          <p class="listing-meta">${traits}${tags}<span class="dim">${ratingText(rating)} · ${l.addCount} ${l.addCount === 1 ? "adoption" : "adoptions"} · a community creator</span></p>
          <p><a class="btn" href="${DISCORD_INVITE}" target="_blank" rel="noopener noreferrer">Meet ${esc(l.name)} — join the server</a></p>
        </div>
      </div>
      ${l.voicePersona ? `<section><h2>Who they are</h2><p>${nl2br(l.voicePersona)}</p></section>` : ""}
      ${l.backstory ? `<section><h2>Backstory</h2><p>${nl2br(l.backstory)}</p></section>` : ""}
      ${l.greeting ? `<section><h2>The first hello</h2><blockquote class="greet">${nl2br(l.greeting)}</blockquote></section>` : ""}
      ${l.openings.length ? `<section><h2>More ways to meet</h2>${l.openings.map(o => `<blockquote class="greet">${nl2br(o)}</blockquote>`).join("")}</section>` : ""}
      ${related.length ? `<section><h2>More like this</h2><div class="grid grid-tight">\n${related.map(o => listingCard(o, undefined)).join("\n")}\n      </div></section>` : ""}
      <p class="cta-back"><a href="/characters">← Back to the shelf</a></p>
    </article>`,
  });
}

/** Real 404 for delisted/unknown ids — a gone listing must drop out of the
 *  index, not linger as a soft-404. */
export function notFoundPage(): string {
  return shell({
    title: "Off the shelf · Characterly",
    description: "This listing isn't on the shelf — it may have been delisted or taken down.",
    canonical: `${SITE_ORIGIN}/characters`,
    body: `    <section class="shelf">
      <h1>Off the shelf.</h1>
      <p class="lede">This companion isn't listed anymore — it may have been delisted or taken down. The rest of the shelf is still open.</p>
      <p><a class="btn" href="/characters">Browse the shelf</a></p>
    </section>`,
  });
}

// ── Sitemap ──────────────────────────────────────────────────────────────────

export const SITEMAP_STATIC_PATHS = ["/", "/characters", "/guides/import-character-cards", "/guides/leaving-character-ai", "/safety", "/privacy", "/terms", "/security"];

export function sitemapXml(rows: Array<{ id: number; updatedAt: string }>, origin = SITE_ORIGIN): string {
  const urls = SITEMAP_STATIC_PATHS.map(p => `  <url><loc>${origin}${p}</loc></url>`);
  for (const r of rows) {
    const lastmod = r.updatedAt ? `\n    <lastmod>${esc(r.updatedAt.slice(0, 10))}</lastmod>` : "";
    urls.push(`  <url>\n    <loc>${origin}/characters/${r.id}</loc>${lastmod}\n  </url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`;
}
