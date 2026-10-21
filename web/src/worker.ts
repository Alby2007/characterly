// Worker entry for the Astro site. Owns everything that is not a page:
//   POST /discord/events  Discord Webhook Events (app installs)
//   PUT  /avatar          bot re-hosts companion avatars (shared secret)
//   POST /avatar/gc       daily sweep of unreferenced avatars (shared secret)
//   POST /track           allowlisted funnel beacons
// plus the canonical-host redirect, security headers and page_view analytics
// on every page. Everything else is handed to Astro's Cloudflare handler,
// which serves prerendered assets and renders on-demand routes.
//
// Handler logic is ported verbatim from website/worker.ts. Secrets (wrangler
// secret put): DISCORD_APP_PUBLIC_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// AVATAR_UPLOAD_SECRET.
import { handle } from "@astrojs/cloudflare/handler";
import { verifyDiscordSignature, parseDiscordEvent } from "../../src/discord-events.ts";

interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DISCORD_APP_PUBLIC_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AVATAR_UPLOAD_SECRET?: string;
  /** "off" on the preview Worker (wrangler.jsonc env.preview). */
  CANONICAL_REDIRECT?: string;
  /** "1" on the preview Worker: every response gets X-Robots-Tag: noindex. */
  NOINDEX?: string;
  ANALYTICS?: { writeDataPoint(d: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void };
}

const EVENTS_PATH = "/discord/events";
const AVATAR_PATH = "/avatar";
const AVATAR_GC_PATH = "/avatar/gc";
const TRACK_PATH = "/track";
const API_PATHS = new Set([EVENTS_PATH, AVATAR_PATH, AVATAR_GC_PATH, TRACK_PATH]);
const AVATAR_BUCKET = "companion-avatars";
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
const AVATAR_TYPES = /^image\/(png|jpe?g|webp|gif)$/;
// GC only collects objects older than this: a just-uploaded avatar whose row
// write hasn't landed yet is off limits.
const AVATAR_GC_MIN_AGE_MS = 24 * 60 * 60 * 1000;

// CSP: every script is a bundled file (astro.config.mjs disables inlining), so
// script-src needs no hashes. JSON-LD blocks are data and never execute.
// connect-src covers Supabase only; Stripe checkout is a top-level navigation.
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; "),
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const CANONICAL_HOST = "characterly.app";
const isLocalHost = (h: string) => h.startsWith("localhost") || h.startsWith("127.") || h === "[::1]";

/** Stamp the security headers on any response — pages and API both. `noindex`
 *  marks the preview Worker so it can never enter the index as a duplicate. */
const withSecurity = (res: Response, noindex = false): Response => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    // Astro's dev server injects inline scripts; the policy is production-only.
    if (import.meta.env.DEV && k === "content-security-policy") continue;
    out.headers.set(k, v);
  }
  if (noindex) out.headers.set("x-robots-tag", "noindex");
  return out;
};

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const api = API_PATHS.has(url.pathname);

    // One canonical host AND one canonical path shape for pages — a trailing
    // slash is a duplicate URL, so both fix in a single hop. FIX: API paths
    // are exempt — a 301 turns a POST into a GET, which silently broke
    // webhooks sent to www/workers.dev.
    const hostMismatch = url.hostname !== CANONICAL_HOST && !isLocalHost(url.hostname);
    const cleanPath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    if (!api && env.CANONICAL_REDIRECT !== "off" && (hostMismatch || cleanPath !== url.pathname)) {
      const origin = hostMismatch ? `https://${CANONICAL_HOST}` : url.origin;
      return Response.redirect(`${origin}${cleanPath}${url.search}`, 301);
    }

    const noindex = env.NOINDEX === "1";
    if (url.pathname === EVENTS_PATH) {
      if (request.method !== "POST") return withSecurity(new Response("method not allowed", { status: 405 }), noindex);
      return withSecurity(await handleDiscordEvent(request, env), noindex);
    }
    if (url.pathname === AVATAR_PATH && request.method === "PUT") return withSecurity(await handleAvatarUpload(request, env), noindex);
    if (url.pathname === AVATAR_GC_PATH && request.method === "POST") return withSecurity(await handleAvatarGc(request, env), noindex);
    if (url.pathname === TRACK_PATH && request.method === "POST") return withSecurity(await handleTrack(request, env), noindex);

    const res = await handle(request, env as never, ctx);

    // Page views: navigations only (no file extension, or .html). Path,
    // referer HOST and status are all we keep: no IPs, query strings, cookies.
    if (request.method === "GET" && !api && !/\.[a-z0-9]+$/i.test(url.pathname.replace(/\.html$/i, ""))) {
      let refHost = "";
      try { refHost = new URL(request.headers.get("referer") ?? "").hostname; } catch { /* none */ }
      trackAe(env, "page_view", [url.pathname, refHost], [res.status]);
    }
    return withSecurity(res, noindex);
  },
};

/** One Analytics Engine datapoint. A missing binding is a silent no-op:
 *  analytics must never break the site. */
function trackAe(env: WorkerEnv, event: string, blobs: string[] = [], doubles: number[] = []): void {
  try {
    env.ANALYTICS?.writeDataPoint({ indexes: [event], blobs: [event, ...blobs], doubles });
  } catch { /* binding absent or datapoint rejected */ }
}

// POST /track: allowlisted event names, no user data; anything else is a
// quiet 204, so the endpoint is useless for abuse.
export const TRACKED_EVENTS = new Set(["signup_start", "signup_done", "checkout_click", "link_attempt", "discord_signin_click"]);
async function handleTrack(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    const { e, p } = await request.json() as { e?: string; p?: string };
    if (e && TRACKED_EVENTS.has(e)) trackAe(env, "web_event", [e, typeof p === "string" ? p.slice(0, 80) : ""]);
  } catch { /* malformed body: still 204 */ }
  return new Response(null, { status: 204 });
}

/** Constant-time shared-secret check: both sides are hashed to a fixed length
 *  first, so neither early exit nor a length mismatch leaks timing. */
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

// The bucket is ensured once per isolate. Create is idempotent (an existing
// bucket errors, which we ignore); a network failure clears the slot so the
// next upload retries.
let bucketReady: Promise<unknown> | null = null;
function ensureAvatarBucket(base: string, auth: Record<string, string>): Promise<unknown> {
  bucketReady ??= fetch(`${base}/storage/v1/bucket`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ id: AVATAR_BUCKET, name: AVATAR_BUCKET, public: true }),
  }).then(() => {}, () => { bucketReady = null; });
  return bucketReady;
}

/** Magic bytes → the real image family, or null. Caller compares against the
 *  declared content-type; "jpg" covers both jpeg/jpg spellings. */
function sniffedImageType(body: ArrayBuffer): "png" | "jpg" | "webp" | "gif" | null {
  const b = new Uint8Array(body);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp"; // RIFF…WEBP
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif"; // GIF8
  return null;
}

/** The bot re-hosts companion images so avatar_url values outlive Discord CDN
 *  signatures and hotlink rot. */
async function handleAvatarUpload(request: Request, env: WorkerEnv): Promise<Response> {
  if (!env.AVATAR_UPLOAD_SECRET || !(await secretMatches(request.headers.get("x-characterly-secret"), env.AVATAR_UPLOAD_SECRET))) {
    return new Response("unauthorized", { status: 401 });
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const m = AVATAR_TYPES.exec(contentType);
  if (!m) return new Response("png/jpeg/webp/gif only", { status: 415 });
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > AVATAR_MAX_BYTES) return new Response("invalid size", { status: 413 });
  // The declared type is self-reported; the magic bytes are the truth. A
  // mismatched body (HTML labelled image/png) must not land in public storage.
  const sniffed = sniffedImageType(body);
  if (!sniffed || (sniffed === "jpg" ? m[1] !== "jpeg" && m[1] !== "jpg" : sniffed !== m[1])) {
    return new Response("content-type doesn't match the file", { status: 415 });
  }
  const base = env.SUPABASE_URL?.replace(/\/+$/, "");
  if (!base || !env.SUPABASE_SERVICE_ROLE_KEY) return new Response("storage unconfigured", { status: 500 });
  const auth = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  await ensureAvatarBucket(base, auth);
  const key = `${crypto.randomUUID()}.${m[1] === "jpeg" || m[1] === "jpg" ? "jpg" : m[1]}`;
  const put = () => fetch(`${base}/storage/v1/object/${AVATAR_BUCKET}/${key}`, {
    method: "POST", headers: { ...auth, "content-type": contentType, "x-upsert": "true" }, body,
  });
  let up = await put();
  if (up.status === 404) { // bucket deleted out-of-band: re-ensure, one retry
    bucketReady = null;
    await ensureAvatarBucket(base, auth);
    up = await put();
  }
  if (!up.ok) return new Response("upload failed", { status: 502 });
  trackAe(env, "avatar_upload", [], [body.byteLength]);
  return Response.json({ url: `${base}/storage/v1/object/public/${AVATAR_BUCKET}/${key}` });
}

/** Deletes companion-avatars objects no row references any more, older than
 *  AVATAR_GC_MIN_AGE_MS. card-avatars (uid folders) is out of scope. */
async function handleAvatarGc(request: Request, env: WorkerEnv): Promise<Response> {
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
  // Persona-version snapshots embed the same hosted URL inside persona_json;
  // a rollback must never find its avatar collected.
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
      if (res.status === 400 || res.status === 404) break; // no bucket: nothing to collect
      return new Response("list failed", { status: 502 });
    }
    const objects = (await res.json()) as Array<{ name: string; created_at?: string }>;
    for (const o of objects) {
      // Missing/unparseable created_at → NaN → kept (safe side of the cutoff).
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

async function handleDiscordEvent(request: Request, env: WorkerEnv): Promise<Response> {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = await request.text();
  if (!signature || !timestamp || !env.DISCORD_APP_PUBLIC_KEY) return new Response("unauthorized", { status: 401 });
  const ok = await verifyDiscordSignature(env.DISCORD_APP_PUBLIC_KEY, signature, timestamp, body);
  if (!ok) return new Response("invalid signature", { status: 401 });
  // A valid signature is replayable forever without a freshness window;
  // Discord's own redeliveries arrive within seconds.
  const eventTs = Number(timestamp);
  if (!Number.isFinite(eventTs) || Math.abs(Date.now() / 1000 - eventTs) > 300) {
    return new Response("stale timestamp", { status: 401 });
  }
  const action = parseDiscordEvent(body);
  if (action.kind === "install") {
    const base = env.SUPABASE_URL?.replace(/\/+$/, "");
    if (!base || !env.SUPABASE_SERVICE_ROLE_KEY) return new Response("upstream unconfigured", { status: 500 });
    const res = await fetch(`${base}/rest/v1/rpc/record_app_install`, {
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
    trackAe(env, "discord_event", [action.event]);
  }
  return new Response(null, { status: 204 });
}
