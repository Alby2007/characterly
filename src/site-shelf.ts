// Public, worker-rendered shelf — /characters, /characters/<id>, /sitemap.xml.
// The marketplace's indexable surface: every listing shown here passed
// status='active' (published, unflagged, unbanned, listed) — the same gate the
// Discord shelf shows. Lives in src/ so the backend test suite exercises the
// templates; the website worker imports it for its routes.
//
// SECURITY CONTRACT: every interpolated listing field passes esc() — names,
// backstories, greetings and traits are user-authored. Publish-time screening
// is not a substitute for output encoding on a first-party domain.

/** Server invite — mirrors website/src/config.js LINKS.discord. Keep in sync
 *  (this module is plain TS, not a vite page, so it can't import the site
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
  greeting: string; avatar_url: string | null; add_count: number; updated_at: string;
};

const LISTING_SELECT = "id,name,tagline,voice_persona,core_traits,creator_tags,backstory,greeting,avatar_url,add_count,updated_at";

function restBase(env: ShelfEnv): { base: string; headers: Record<string, string> } | null {
  const base = env.SUPABASE_URL?.replace(/\/+$/, "");
  if (!base || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return {
    base,
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  };
}

const toListing = (r: RawListing): ShelfListing => ({
  id: r.id, name: r.name ?? "", tagline: r.tagline ?? "", voicePersona: r.voice_persona ?? "",
  coreTraits: r.core_traits ?? [], creatorTags: r.creator_tags ?? [],
  backstory: r.backstory ?? "", greeting: r.greeting ?? "",
  avatarUrl: r.avatar_url ?? null, addCount: r.add_count ?? 0, updatedAt: r.updated_at ?? "",
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

export async function fetchListing(env: ShelfEnv, id: number): Promise<ShelfListing | null> {
  const rest = restBase(env);
  if (!rest || !Number.isInteger(id) || id <= 0) return null;
  const res = await fetch(`${rest.base}/rest/v1/companion_listings?select=${LISTING_SELECT}&status=eq.active&id=eq.${id}&limit=1`, { headers: rest.headers }).catch(() => null);
  if (!res?.ok) return null;
  const rows = (await res.json().catch(() => [])) as RawListing[];
  return rows[0] ? toListing(rows[0]) : null;
}

export async function fetchListingRating(env: ShelfEnv, listingId: number): Promise<ShelfRating> {
  const rest = restBase(env);
  if (!rest) return { avg: 0, count: 0 };
  const res = await fetch(`${rest.base}/rest/v1/listing_ratings?select=stars&listing_id=eq.${listingId}`, { headers: rest.headers }).catch(() => null);
  if (!res?.ok) return { avg: 0, count: 0 };
  const rows = (await res.json().catch(() => [])) as Array<{ stars: number }>;
  if (!Array.isArray(rows) || !rows.length) return { avg: 0, count: 0 };
  return { avg: rows.reduce((a, r) => a + r.stars, 0) / rows.length, count: rows.length };
}

/** All rating stats in one query — the index renders every card's stars. */
export async function fetchRatingStats(env: ShelfEnv): Promise<Map<number, ShelfRating>> {
  const rest = restBase(env);
  const out = new Map<number, ShelfRating>();
  if (!rest) return out;
  const res = await fetch(`${rest.base}/rest/v1/listing_ratings?select=listing_id,stars`, { headers: rest.headers }).catch(() => null);
  if (!res?.ok) return out;
  const rows = (await res.json().catch(() => [])) as Array<{ listing_id: number; stars: number }>;
  if (!Array.isArray(rows)) return out;
  const acc = new Map<number, { sum: number; count: number }>();
  for (const r of rows) {
    const e = acc.get(r.listing_id) ?? { sum: 0, count: 0 };
    e.sum += r.stars; e.count++;
    acc.set(r.listing_id, e);
  }
  for (const [id, v] of acc) out.set(id, { avg: v.sum / v.count, count: v.count });
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
 *  whole catalog in one page. */
export function listingIndexPage(listings: ShelfListing[], ratings: Map<number, ShelfRating>): string {
  const cards = listings.map(l => listingCard(l, ratings.get(l.id))).join("\n");
  const itemList = {
    "@context": "https://schema.org", "@type": "ItemList",
    itemListElement: listings.map((l, i) => ({
      "@type": "ListItem", position: i + 1, url: `${SITE_ORIGIN}/characters/${l.id}`, name: l.name,
    })),
  };
  return shell({
    title: "The shelf · Characterly",
    description: "Community-published AI companions — browse the shelf, then meet yours inside the Characterly Discord server.",
    canonical: `${SITE_ORIGIN}/characters`,
    jsonLd: [itemList],
    body: `    <section class="shelf">
      <p class="label">The marketplace</p>
      <h1>The shelf.</h1>
      <p class="lede">Community-published companions — each one keeps a private memory of you, lives in your DMs, and follows you into your servers. Pick one up inside <a href="${DISCORD_INVITE}" target="_blank" rel="noopener noreferrer">the Characterly server</a>.</p>
      ${listings.length ? `<div class="grid">\n${cards}\n      </div>` : `<p class="lede dim">Nothing on the shelf yet — be the first to publish.</p>`}
    </section>`,
  });
}

/** /characters/<id> — one indexable page per published listing. CreativeWork
 *  schema (characters are authored works) + BreadcrumbList; aggregateRating is
 *  emitted only with a real rating count — Google penalizes empty ones. */
export function listingPage(l: ShelfListing, rating: ShelfRating): string {
  const canonical = `${SITE_ORIGIN}/characters/${l.id}`;
  const title = `${l.name} · Characterly`;
  const description = l.tagline || `${l.name} — a community companion on the Characterly shelf.`;
  const traits = l.coreTraits.slice(0, 6).map(t => `<span class="tag">${esc(t)}</span>`).join("");
  const tags = l.creatorTags.slice(0, 4).map(t => `<span class="tag tag-dim">${esc(t)}</span>`).join("");
  const creativeWork: Record<string, unknown> = {
    "@context": "https://schema.org", "@type": "CreativeWork",
    name: l.name, description, url: canonical,
    ...(l.avatarUrl ? { image: l.avatarUrl } : {}),
    author: { "@type": "Organization", name: "Characterly community" },
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
    ogType: "profile",
    jsonLd: [creativeWork, crumbs],
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

export const SITEMAP_STATIC_PATHS = ["/", "/characters", "/safety", "/privacy", "/terms", "/security"];

export function sitemapXml(rows: Array<{ id: number; updatedAt: string }>, origin = SITE_ORIGIN): string {
  const urls = SITEMAP_STATIC_PATHS.map(p => `  <url><loc>${origin}${p}</loc></url>`);
  for (const r of rows) {
    const lastmod = r.updatedAt ? `\n    <lastmod>${esc(r.updatedAt.slice(0, 10))}</lastmod>` : "";
    urls.push(`  <url>\n    <loc>${origin}/characters/${r.id}</loc>${lastmod}\n  </url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`;
}
