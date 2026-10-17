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

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DISCORD_APP_PUBLIC_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AVATAR_UPLOAD_SECRET?: string;
}

const EVENTS_PATH = "/discord/events";
const AVATAR_PATH = "/avatar";
const AVATAR_BUCKET = "companion-avatars";
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
const AVATAR_TYPES = /^image\/(png|jpe?g|webp|gif)$/;

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === EVENTS_PATH) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleDiscordEvent(request, env);
    }
    if (url.pathname === AVATAR_PATH && request.method === "PUT") {
      return handleAvatarUpload(request, env);
    }
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },
};

/** The bot re-hosts companion images so avatar_url values outlive Discord CDN
 *  signatures + hotlink rot. Shared-secret auth → public Supabase Storage
 *  bucket (created lazily — no manual provisioning). */
async function handleAvatarUpload(request: Request, env: Env): Promise<Response> {
  if (!env.AVATAR_UPLOAD_SECRET || request.headers.get("x-characterly-secret") !== env.AVATAR_UPLOAD_SECRET) {
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
  await fetch(`${base}/storage/v1/bucket`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ id: AVATAR_BUCKET, name: AVATAR_BUCKET, public: true }),
  }).catch(() => {}); // 409 = exists — ensure, don't error
  const key = `${crypto.randomUUID()}.${m[1] === "jpeg" || m[1] === "jpg" ? "jpg" : m[1]}`;
  const up = await fetch(`${base}/storage/v1/object/${AVATAR_BUCKET}/${key}`, {
    method: "POST", headers: { ...auth, "content-type": contentType, "x-upsert": "true" }, body,
  });
  if (!up.ok) return new Response("upload failed", { status: 502 });
  return Response.json({ url: `${base}/storage/v1/object/public/${AVATAR_BUCKET}/${key}` });
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
  return new Response(null, { status: 204 });
}
