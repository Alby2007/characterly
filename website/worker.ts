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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === EVENTS_PATH) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleDiscordEvent(request, env);
    }
    return env.ASSETS.fetch(request);
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
