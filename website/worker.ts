// Website worker — serves static assets by default; owns POST /discord/events
// (Discord Webhook Events). Signature verification + envelope parsing live in
// ../src/discord-events.ts so the backend test suite can exercise them.
//
// Env (set via `cf secret`):
//   DISCORD_APP_PUBLIC_KEY      — app public key (dev portal → General Info)
//   SUPABASE_URL                — project URL
//   SUPABASE_SERVICE_ROLE_KEY   — service role key (server-side only)

import { verifyDiscordSignature, parseDiscordEvent } from "../src/discord-events.ts";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DISCORD_APP_PUBLIC_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

const EVENTS_PATH = "/discord/events";

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
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },
};

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
