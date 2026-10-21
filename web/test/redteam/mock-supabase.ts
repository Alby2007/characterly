// Impersonates every Supabase surface the site touches — PostgREST reads for
// the shelf, RPCs the client/worker call, Storage for the avatar endpoints,
// and just enough GoTrue for a seeded browser session. Fixture-driven so
// hostile data flows through the REAL SSR pipeline end-to-end.
//
// Admin surface (all prefixed /__ so a real Supabase can never collide):
//   POST /__fixture   { listings?, ratingStats?, rpc?: {name: any}, broken?: boolean, profile? }
//   GET  /__log       → MockCall[]   POST /__reset → clears log
import http from "node:http";

export interface MockCall { method: string; url: string; body: string; apikey?: string | string[]; }

interface State {
  listings: unknown[];
  ratingStats: unknown[];
  profile: unknown;
  rpc: Map<string, unknown>;
  broken: boolean;
}

const CLEAN_LISTING = {
  id: 1, name: "Wren", tagline: "the friend who always has time for you",
  voice_persona: "speaks softly", core_traits: ["patient"], creator_tags: ["original"],
  backstory: "keeps the stacks", greeting: "shh, welcome.", avatar_url: null,
  add_count: 12, updated_at: "2026-10-01T00:00:00Z",
};

const FAKE_USER = { id: "00000000-0000-0000-0000-00000000b001", aud: "authenticated", role: "authenticated", email: "red@team.test" };

export function startMockSupabase(listings: unknown[] = [CLEAN_LISTING], ratingStats: unknown[] = []) {
  const calls: MockCall[] = [];
  const state: State = {
    listings, ratingStats,
    profile: { id: FAKE_USER.id, display_name: "Red Teamer", discord_user_id: "4242", discord_username: "redteam", discord_avatar_url: null, plan: "free", credit_balance: 30, purchased_balance: 0 },
    rpc: new Map<string, unknown>([
      ["my_companions", []],
      ["my_bot_settings", {}],
      ["my_byok_status", { has_key: false }],
      ["my_consent", 1],
      ["my_chat_imports", []],
    ]),
    broken: false,
  };

  const json = (res: http.ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method ?? "?", url: url.pathname + url.search, body: body.slice(0, 400), apikey: req.headers.apikey });

    // ── Admin ──
    if (url.pathname === "/__log") return json(res, calls);
    if (url.pathname === "/__reset") { calls.length = 0; return json(res, { ok: true }); }
    if (url.pathname === "/__fixture" && req.method === "POST") {
      const f = JSON.parse(body || "{}");
      if (f.listings) state.listings = f.listings;
      if (f.ratingStats) state.ratingStats = f.ratingStats;
      if (f.profile) state.profile = f.profile;
      if (f.rpc) for (const [k, v] of Object.entries(f.rpc)) state.rpc.set(k, v);
      if (typeof f.broken === "boolean") state.broken = f.broken;
      return json(res, { ok: true });
    }

    if (state.broken) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("this is not json at all <<<");
    }

    // ── GoTrue (enough for a seeded session) ──
    if (url.pathname === "/auth/v1/user") return json(res, FAKE_USER);
    if (url.pathname === "/auth/v1/token") return json(res, { access_token: "mock", refresh_token: "mock", expires_in: 3600, token_type: "bearer", user: FAKE_USER });
    if (url.pathname === "/auth/v1/authorize") {
      const target = url.searchParams.get("redirect_to") ?? "";
      res.writeHead(302, { location: target || "/" });
      return res.end();
    }

    // ── PostgREST reads ──
    if (url.pathname === "/rest/v1/companion_listings") {
      let rows = state.listings as any[];
      const idEq = url.search.match(/id=eq\.(\d+)/);
      if (idEq) rows = rows.filter(r => r.id === Number(idEq[1]));
      return json(res, rows);
    }
    if (url.pathname === "/rest/v1/listing_rating_stats") {
      let rows = state.ratingStats as any[];
      const idEq = url.search.match(/listing_id=eq\.(\d+)/);
      if (idEq) rows = rows.filter(r => r.listing_id === Number(idEq[1]));
      return json(res, rows);
    }
    if (url.pathname === "/rest/v1/web_profiles") return json(res, [state.profile]);
    if (url.pathname === "/rest/v1/credit_ledger") return json(res, []);
    if (url.pathname.startsWith("/rest/v1/companions") || url.pathname.startsWith("/rest/v1/companion_persona_versions")) return json(res, []);

    // ── RPCs ──
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = url.pathname.slice("/rest/v1/rpc/".length);
      if (state.rpc.has(name)) return json(res, state.rpc.get(name));
      return json(res, null);
    }

    // ── Storage ──
    if (url.pathname === "/storage/v1/bucket" && req.method === "POST") return json(res, { name: "ok" });
    if (url.pathname.startsWith("/storage/v1/object/list/")) return json(res, []);
    if (url.pathname.startsWith("/storage/v1/object/")) {
      if (req.method === "DELETE") return json(res, []);
      return json(res, { Key: url.pathname.replace("/storage/v1/object/", "") });
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "mock: no route", path: url.pathname }));
  });

  return new Promise<{
    port: number;
    calls: MockCall[];
    close: () => void;
    count: (pred: (c: MockCall) => boolean) => number;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({
        port, calls, close: () => server.close(),
        count: (pred) => calls.filter(pred).length,
      });
    });
  });
}
