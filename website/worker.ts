// Website worker — serves static assets by default; owns POST /discord/events
// (Discord Webhook Events). Signature verification + envelope parsing live in
// ../src/discord-events.ts so the backend test suite can exercise them.
//
// Env (set via `cf secret`):
//   DISCORD_APP_PUBLIC_KEY      — app public key (dev portal → General Info)
//   SUPABASE_URL                — project URL
//   SUPABASE_SERVICE_ROLE_KEY   — service role key (server-side only)
//   AVATAR_UPLOAD_SECRET        — shared secret the bot sends on PUT /avatar

import { verifyDiscordSignature, parseDiscordEvent } from "../src/discord-events.ts";
import {
  fetchActiveListings, fetchListing, fetchListingRating, fetchRatingStats,
  listingIndexPage, listingPage, notFoundPage, sitemapXml,
} from "../src/site-shelf.ts";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DISCORD_APP_PUBLIC_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AVATAR_UPLOAD_SECRET?: string;
  ANALYTICS?: { writeDataPoint(d: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void };
}

const EVENTS_PATH = "/discord/events";
const AVATAR_PATH = "/avatar";
const AVATAR_GC_PATH = "/avatar/gc";
const TRACK_PATH = "/track";
const AVATAR_BUCKET = "companion-avatars";
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
const AVATAR_TYPES = /^image\/(png|jpe?g|webp|gif)$/;
// Replaced avatars go unreferenced the moment the companions row updates, but
// GC only collects objects older than this — a just-uploaded avatar whose
// row write hasn't landed yet is off limits.
const AVATAR_GC_MIN_AGE_MS = 24 * 60 * 60 * 1000;

// Baseline hardening for every asset response. CSP notes:
//  - script-src allows 'self' + the sha256 of the one inline script every page
//    shares (documentElement .js toggle — verbatim between the tags). Change
//    that script and this hash must be recomputed or the pages break.
//  - style-src keeps 'unsafe-inline' — the reveal system uses inline style=""
//    attributes everywhere; attribute-level CSS injection is low risk here.
//  - connect-src covers Supabase (auth/rest/rpc/storage) only; Stripe is a
//    top-level navigation, never an XHR.
//  - frame-ancestors 'none' = clickjacking protection on the dashboard.
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' 'sha256-qOhFsq0QMV2REqNwk5hGH5bZE9SkX6gt6yeyKdYPv+U='",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const CANONICAL_HOST = "characterly.app";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // One canonical host — www and workers.dev duplicate the whole site and
    // split link equity. Permanent redirect so search consolidates on apex.
    // Local dev hosts pass through untouched.
    if (url.hostname !== CANONICAL_HOST && !url.hostname.startsWith("localhost") && !url.hostname.startsWith("127.")) {
      return Response.redirect(`https://${CANONICAL_HOST}${url.pathname}${url.search}`, 301);
    }
    if (url.pathname === EVENTS_PATH) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleDiscordEvent(request, env);
    }
    if (url.pathname === AVATAR_PATH && request.method === "PUT") {
      return handleAvatarUpload(request, env);
    }
    if (url.pathname === AVATAR_GC_PATH && request.method === "POST") {
      return handleAvatarGc(request, env);
    }
    if (url.pathname === TRACK_PATH && request.method === "POST") {
      return handleTrack(request, env);
    }
    // The public shelf + sitemap are the only worker-rendered pages — the
    // marketplace lives in Postgres, so these stream live rows rather than a
    // vite bundle. Everything else falls through to static assets.
    const res = request.method === "GET" && isShelfPath(url.pathname)
      ? await handleShelf(url.pathname, env)
      : await env.ASSETS.fetch(request);
    // Page views: navigation loads only (a path with no file extension, or
    // .html) — not every css/js/font fetch, and not stray GETs on the POST-only
    // API paths (they 404 through the asset layer). Path + referer HOST +
    // status is all we keep: no IPs, no query strings, no cookies.
    if (request.method === "GET" && url.pathname !== TRACK_PATH && url.pathname !== AVATAR_PATH && url.pathname !== AVATAR_GC_PATH && !/\.[a-z0-9]+$/i.test(url.pathname.replace(/\.html$/i, ""))) {
      let refHost = "";
      try { refHost = new URL(request.headers.get("referer") ?? "").hostname; } catch { /* none */ }
      trackAe(env, "page_view", [url.pathname, refHost], [res.status]);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },
};

const SHELF_LISTING_RE = /^\/characters\/(\d+)\/?$/;
const isShelfPath = (p: string): boolean =>
  p === "/sitemap.xml" || p === "/characters" || p === "/characters/" || SHELF_LISTING_RE.test(p);

// ~5min edge cache: fresh enough that a delist surfaces quickly, lazy enough
// that a crawl doesn't hammer PostgREST.
const SHELF_CACHE = "public, max-age=60, s-maxage=300";

async function handleShelf(pathname: string, env: Env): Promise<Response> {
  const html = { "content-type": "text/html; charset=utf-8", "cache-control": SHELF_CACHE };
  if (pathname === "/sitemap.xml") {
    const listings = await fetchActiveListings(env);
    return new Response(sitemapXml(listings.map(l => ({ id: l.id, updatedAt: l.updatedAt }))), {
      headers: { "content-type": "application/xml; charset=utf-8", "cache-control": SHELF_CACHE },
    });
  }
  const m = SHELF_LISTING_RE.exec(pathname);
  if (m) {
    const id = Number(m[1]);
    const [listing, rating] = await Promise.all([fetchListing(env, id), fetchListingRating(env, id)]);
    // Delisted/unknown ids get a real 404 — they drop out of the index and
    // the sitemap instead of lingering as a soft-404.
    if (!listing) return new Response(notFoundPage(), { status: 404, headers: html });
    return new Response(listingPage(listing, rating), { headers: html });
  }
  const [listings, ratings] = await Promise.all([fetchActiveListings(env), fetchRatingStats(env)]);
  return new Response(listingIndexPage(listings, ratings), { headers: html });
}

/** One Analytics Engine datapoint. Guarded so local dev / a missing binding
 *  is a silent no-op — analytics must never break the site. */
function trackAe(env: Env, event: string, blobs: string[] = [], doubles: number[] = []): void {
  try {
    env.ANALYTICS?.writeDataPoint({ indexes: [event], blobs: [event, ...blobs], doubles });
  } catch { /* binding absent or datapoint rejected */ }
}

// POST /track — the site's only client-side funnel hook (sendBeacon from
// auth/dashboard flows). Event names are allowlisted and carry no user data;
// anything else is a quiet 204, so the endpoint is useless for abuse.
const TRACKED_EVENTS = new Set(["signup_start", "signup_done", "checkout_click", "link_attempt"]);
async function handleTrack(request: Request, env: Env): Promise<Response> {
  try {
    const { e, p } = await request.json() as { e?: string; p?: string };
    if (e && TRACKED_EVENTS.has(e)) {
      trackAe(env, "web_event", [e, typeof p === "string" ? p.slice(0, 80) : ""]);
    }
  } catch { /* malformed body — still 204 */ }
  return new Response(null, { status: 204 });
}

/** Constant-time shared-secret check — both sides are hashed to a fixed
 *  length first so neither early-exit nor a length mismatch leaks timing. */
async function secretMatches(given: string | null, expected: string): Promise<boolean> {
  if (!given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// The bucket is ensured once per isolate, not on every upload — create is
// idempotent (Supabase errors on an existing bucket, which we ignore), so
// concurrent requests share one attempt. A network failure clears the slot
// so the next upload retries; a 404 from the object write does the same.
let bucketReady: Promise<unknown> | null = null;
function ensureAvatarBucket(base: string, auth: Record<string, string>): Promise<unknown> {
  bucketReady ??= fetch(`${base}/storage/v1/bucket`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ id: AVATAR_BUCKET, name: AVATAR_BUCKET, public: true }),
  }).then(() => {}, () => { bucketReady = null; });
  return bucketReady;
}

/** The bot re-hosts companion images so avatar_url values outlive Discord CDN
 *  signatures + hotlink rot. Shared-secret auth → public Supabase Storage
 *  bucket (created lazily — no manual provisioning). */
async function handleAvatarUpload(request: Request, env: Env): Promise<Response> {
  if (!env.AVATAR_UPLOAD_SECRET || !(await secretMatches(request.headers.get("x-characterly-secret"), env.AVATAR_UPLOAD_SECRET))) {
    return new Response("unauthorized", { status: 401 });
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const m = AVATAR_TYPES.exec(contentType);
  if (!m) return new Response("png/jpeg/webp/gif only", { status: 415 });
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > AVATAR_MAX_BYTES) return new Response("invalid size", { status: 413 });
  const base = env.SUPABASE_URL?.replace(/\/+$/, "");
  if (!base || !env.SUPABASE_SERVICE_ROLE_KEY) return new Response("storage unconfigured", { status: 500 });
  const auth = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  await ensureAvatarBucket(base, auth);
  const key = `${crypto.randomUUID()}.${m[1] === "jpeg" || m[1] === "jpg" ? "jpg" : m[1]}`;
  const put = () => fetch(`${base}/storage/v1/object/${AVATAR_BUCKET}/${key}`, {
    method: "POST", headers: { ...auth, "content-type": contentType, "x-upsert": "true" }, body,
  });
  let up = await put();
  if (up.status === 404) { // bucket deleted out-of-band — re-ensure, one retry
    bucketReady = null;
    await ensureAvatarBucket(base, auth);
    up = await put();
  }
  if (!up.ok) return new Response("upload failed", { status: 502 });
  trackAe(env, "avatar_upload", [], [body.byteLength]);
  return Response.json({ url: `${base}/storage/v1/object/public/${AVATAR_BUCKET}/${key}` });
}

/** Deletes companion-avatars objects no row references anymore — a replaced
 *  avatar used to accumulate forever. Only objects past AVATAR_GC_MIN_AGE_MS
 *  are collected, and only names absent from every table that can carry a
 *  hosted URL. The card-avatars bucket (uid folders, user-managed lifecycle)
 *  is out of scope. The bot's daily maintenance calls this; same secret. */
async function handleAvatarGc(request: Request, env: Env): Promise<Response> {
  if (!env.AVATAR_UPLOAD_SECRET || !(await secretMatches(request.headers.get("x-characterly-secret"), env.AVATAR_UPLOAD_SECRET))) {
    return new Response("unauthorized", { status: 401 });
  }
  const base = env.SUPABASE_URL?.replace(/\/+$/, "");
  if (!base || !env.SUPABASE_SERVICE_ROLE_KEY) return new Response("storage unconfigured", { status: 500 });
  const auth = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };

  const referenced = new Set<string>();
  for (const table of ["companions", "companion_listings"]) {
    const res = await fetch(`${base}/rest/v1/${table}?select=avatar_url&avatar_url=like.*/${AVATAR_BUCKET}/*`, { headers: auth });
    if (!res.ok) return new Response("reference lookup failed", { status: 502 });
    for (const row of (await res.json()) as Array<{ avatar_url: string | null }>) {
      const name = row.avatar_url?.split(`/${AVATAR_BUCKET}/`)[1];
      if (name) referenced.add(name);
    }
  }
  // Persona-version snapshots embed the same hosted URL inside persona_json —
  // nothing reads them today, but if a rollback ever restores one its avatar
  // must not have been collected out from under it.
  {
    const res = await fetch(`${base}/rest/v1/companion_persona_versions?select=persona_json&persona_json-%3E%3EavatarUrl=like.*/${AVATAR_BUCKET}/*`, { headers: auth });
    if (!res.ok) return new Response("reference lookup failed", { status: 502 });
    for (const row of (await res.json()) as Array<{ persona_json: { avatarUrl?: string | null } | null }>) {
      const name = row.persona_json?.avatarUrl?.split(`/${AVATAR_BUCKET}/`)[1];
      if (name) referenced.add(name);
    }
  }

  const cutoff = Date.now() - AVATAR_GC_MIN_AGE_MS;
  const stale: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${base}/storage/v1/object/list/${AVATAR_BUCKET}`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ prefix: "", limit: 1000, offset, sortBy: { column: "created_at", order: "asc" } }),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 404) break; // no bucket — nothing to collect
      return new Response("list failed", { status: 502 });
    }
    const objects = (await res.json()) as Array<{ name: string; created_at?: string }>;
    for (const o of objects) {
      // Unparseable/missing created_at → NaN → kept: safe side of the cutoff.
      if (!referenced.has(o.name) && Date.parse(o.created_at ?? "") < cutoff) stale.push(o.name);
    }
    if (objects.length < 1000) break;
  }
  if (stale.length) {
    const del = await fetch(`${base}/storage/v1/object/${AVATAR_BUCKET}`, {
      method: "DELETE", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ prefixes: stale }),
    });
    if (!del.ok) return new Response("delete failed", { status: 502 });
  }
  trackAe(env, "avatar_gc", [], [stale.length]);
  return Response.json({ referenced: referenced.size, deleted: stale.length });
}

async function handleDiscordEvent(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = await request.text();
  if (!signature || !timestamp || !env.DISCORD_APP_PUBLIC_KEY) {
    return new Response("unauthorized", { status: 401 });
  }
  const ok = await verifyDiscordSignature(env.DISCORD_APP_PUBLIC_KEY, signature, timestamp, body);
  if (!ok) return new Response("invalid signature", { status: 401 });
  // A valid signature is replayable forever without a freshness window —
  // redeliveries Discord sends itself arrive within seconds, so five minutes
  // is generous. Stale-signed bodies are rejected, not just deduplicated.
  const eventTs = Number(timestamp);
  if (!Number.isFinite(eventTs) || Math.abs(Date.now() / 1000 - eventTs) > 300) {
    return new Response("stale timestamp", { status: 401 });
  }

  const action = parseDiscordEvent(body);
  if (action.kind === "install") {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_app_install`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_user_id: action.userId, p_event: action.event, p_meta: action.meta }),
    });
    // 500 → Discord retries delivery; acking a lost event would drop a greet.
    if (!res.ok) return new Response("upstream error", { status: 500 });
  }
  if (action.kind === "install") trackAe(env, "discord_event", [action.event]);
  return new Response(null, { status: 204 });
}
