// Red-team runner: boots a mock Supabase + a production-shaped wrangler dev
// worker, then runs the attack waves. PASS = defended, FAIL = broken now,
// FINDING = works but worth a human look.
//
//   npm run redteam
//
// Everything is local — the worker's SUPABASE_URL points at the mock, so no
// production credential or origin is involved.
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { startMockSupabase, type MockCall } from "./mock-supabase.ts";
import * as P from "./payloads.ts";
import { safeNext } from "../../src/scripts/auth.ts";
import { readFileSync } from "node:fs";

type Status = "PASS" | "FAIL" | "FINDING" | "INFO";
const results: { wave: string; name: string; status: Status; detail?: string }[] = [];
function report(wave: string, name: string, status: Status, detail = "") {
  results.push({ wave, name, status, detail });
}
function check(wave: string, name: string, fn: () => void | Promise<void>, detail = "") {
  return Promise.resolve()
    .then(fn)
    .then(() => report(wave, name, "PASS", detail))
    .catch((e: Error) => report(wave, name, "FAIL", `${detail} ${e.message}`.trim()));
}
function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function finding(wave: string, name: string, detail: string) {
  report(wave, name, "FINDING", detail);
}

// ── Boot helpers ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function spawnWrangler(port: number, vars: Record<string, string>): { proc: ChildProcess; base: string } {
  const args = ["wrangler", "dev", "--port", String(port)];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  const proc = spawn("npx", args, {
    cwd: new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    shell: true, stdio: "ignore",
    detached: process.platform !== "win32", // own process group → killTree(-pid)
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

// proc.kill() on a shell-spawned child kills only the cmd wrapper — workerd
// stays orphaned and port-bound (SO_REUSEPORT lets the next run's worker
// share the port and serve a stale bundle). Windows needs a tree kill.
function killTree(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.pid == null || proc.killed) return resolve();
    if (process.platform === "win32") {
      const tk = spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)]);
      tk.on("exit", () => resolve());
      tk.on("error", () => resolve());
      return;
    }
    try { process.kill(-proc.pid!, "SIGTERM"); } catch { /* not a group leader */ }
    try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* dead */ } resolve(); }, 1500).unref();
  });
}

async function waitFor(url: string, ms = 45000): Promise<void> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status < 599) return;
      last = r.status;
    } catch (e) { last = e; }
    await sleep(700);
  }
  throw new Error(`timeout waiting for ${url} (${last})`);
}

/** Raw request with a spoofed Host — undici won't let fetch() fake this. */
function rawGet(port: number, path: string, host: string): Promise<{ status: number; location: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, location: String(res.headers.location ?? "") }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Discord forgery kit ─────────────────────────────────────────────────────

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b instanceof Uint8Array ? b : b)].map(x => x.toString(16).padStart(2, "0")).join("");

async function discordKeys() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = hex(await crypto.subtle.exportKey("raw", pair.publicKey));
  const sign = async (timestamp: string, body: string) =>
    hex(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(timestamp + body)));
  return { pub, sign };
}

// ── The waves ───────────────────────────────────────────────────────────────

async function waveEdge(base: string, port: number) {
  const W = "A-edge";
  for (const host of P.HOST_TRICKS) {
    await check(W, `host trick ${host}`, async () => {
      const r = await rawGet(port, "/characters", host);
      if (r.status >= 300 && r.status < 400) {
        assert(r.location.startsWith("https://characterly.app"), `off-origin Location: ${r.location}`);
      } else {
        // A 200 on a foreign host is only observable locally — workerd may
        // normalize Host to the socket. Record it, don't fail on it.
        report(W, `host trick ${host}`, "INFO", `status ${r.status} — Host not honoured into request.url locally; verify on staging`);
        return;
      }
    });
  }
  for (const { path, expect } of P.PATH_TRICKS) {
    await check(W, `path ${JSON.stringify(path)}`, async () => {
      const r = await fetch(base + path, { redirect: "manual" });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location") ?? "";
        assert(!/^(https?:)?\/\//.test(loc) || loc.startsWith(base) || loc.startsWith("https://characterly.app"), `off-origin Location: ${loc}`);
        if (expect === "clean-301") {
          assert(!loc.includes("//", loc.indexOf("://") + 3) && !loc.endsWith("/"), `still unclean: ${loc}`);
        }
      }
      assert(r.status !== 500, "500 on path trick");
    });
  }
  await check(W, "API trailing slash never 301s a POST into GET", async () => {
    for (const p of ["/avatar/", "/track/", "/discord/events/"]) {
      const r = await fetch(base + p, { method: "POST", redirect: "manual", body: "{}" });
      assert(r.status < 300 || r.status >= 400, `${p} redirected a POST (${r.status})`);
    }
  });
  await check(W, "security headers on page, api, 404", async () => {
    const need = ["content-security-policy", "strict-transport-security", "x-content-type-options", "referrer-policy"];
    for (const [label, res] of [
      ["page", await fetch(base + "/characters")],
      ["api", await fetch(base + "/track", { method: "POST", body: '{"e":"signup_start"}' })],
      ["404", await fetch(base + "/nope-nope")],
    ] as const) {
      for (const h of need) assert(res.headers.get(h), `${label} missing ${h}`);
    }
  });
  await check(W, "no x-robots-tag on production env", async () => {
    const r = await fetch(base + "/characters");
    assert(!r.headers.get("x-robots-tag"), "x-robots-tag leaked without NOINDEX");
  });
  await check(W, "method matrix doesn't 500", async () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "DELETE", "PATCH"]) {
      const r = await fetch(base + "/characters", { method: m, redirect: "manual" });
      assert(r.status !== 500, `${m} → 500`);
    }
  });
}

async function waveApi(base: string, mock: { calls: MockCall[]; count: (p: (c: MockCall) => boolean) => number }, sign: (ts: string, body: string) => Promise<string>) {
  const W = "B-api";
  const events = `${base}/discord/events`;
  const avatar = `${base}/avatar`;
  const gc = `${base}/avatar/gc`;
  const track = `${base}/track`;
  const secret = "topsecret";

  await check(W, "unsigned event → 401", async () => {
    assert((await fetch(events, { method: "POST", body: "{}" })).status === 401, "unsigned accepted");
  });
  await check(W, "junk signature → 401", async () => {
    const r = await fetch(events, { method: "POST", headers: { "x-signature-ed25519": "deadbeef", "x-signature-timestamp": String(Date.now() / 1000 | 0) }, body: "{}" });
    assert(r.status === 401, "junk sig accepted");
  });
  await check(W, "tampered body → 401", async () => {
    const ts = String(Date.now() / 1000 | 0);
    const sig = await sign(ts, '{"type":0}');
    const r = await fetch(events, { method: "POST", headers: { "x-signature-ed25519": sig, "x-signature-timestamp": ts }, body: '{"type":1,"event":{}}' });
    assert(r.status === 401, "tampered body verified");
  });
  await check(W, "stale timestamp → 401", async () => {
    const ts = String((Date.now() / 1000 | 0) - 400);
    const body = '{"type":0}';
    const r = await fetch(events, { method: "POST", headers: { "x-signature-ed25519": await sign(ts, body), "x-signature-timestamp": ts }, body });
    assert(r.status === 401, "stale ts accepted");
  });
  await check(W, "non-numeric timestamp → 401", async () => {
    const body = '{"type":0}';
    const r = await fetch(events, { method: "POST", headers: { "x-signature-ed25519": await sign("abc", body), "x-signature-timestamp": "abc" }, body });
    assert(r.status === 401, "non-numeric ts accepted");
  });
  await check(W, "valid PING → 204, no RPC", async () => {
    const ts = String(Date.now() / 1000 | 0);
    const body = '{"type":0}';
    const before = mock.count(c => c.url.includes("record_app_install"));
    const r = await fetch(events, { method: "POST", headers: { "x-signature-ed25519": await sign(ts, body), "x-signature-timestamp": ts }, body });
    assert(r.status === 204, `PING → ${r.status}`);
    assert(mock.count(c => c.url.includes("record_app_install")) === before, "PING fired the install RPC");
  });
  await check(W, "valid install → RPC fires once, replay safe", async () => {
    const body = JSON.stringify({ type: 1, event: { type: "APPLICATION_AUTHORIZED", timestamp: "2026-01-01T00:00:00Z", data: { integration_type: 1, user: { id: "u-red" }, scopes: [] } } });
    for (let i = 0; i < 3; i++) {
      const ts = String(Date.now() / 1000 | 0);
      const r = await fetch(events, { method: "POST", headers: { "x-signature-ed25519": await sign(ts, body), "x-signature-timestamp": ts }, body });
      assert(r.status === 204, `install ${i} → ${r.status}`);
    }
    const n = mock.count(c => c.url.includes("record_app_install") && c.body.includes("u-red"));
    assert(n === 3, `expected 3 RPC calls (upsert idempotent), got ${n}`);
  });
  await check(W, "GET /discord/events → 405", async () => {
    assert((await fetch(events)).status === 405, "GET allowed");
  });

  await check(W, "avatar: no/wrong secret → 401", async () => {
    assert((await fetch(avatar, { method: "PUT", headers: { "content-type": "image/png" }, body: P.MIN_PNG })).status === 401);
    assert((await fetch(avatar, { method: "PUT", headers: { "content-type": "image/png", "x-characterly-secret": "wrong" }, body: P.MIN_PNG })).status === 401);
  });
  for (const c of P.AVATAR_CASES) {
    await check(W, `avatar: ${c.name}`, async () => {
      const headers: Record<string, string> = { "x-characterly-secret": secret };
      if (c.declared) headers["content-type"] = c.declared;
      const r = await fetch(avatar, { method: "PUT", headers, body: (c.bytes ?? new Uint8Array(0)) as BodyInit });
      assert(r.status === c.want, `want ${c.want} got ${r.status}`);
    });
  }
  await check(W, "avatar: >8MB → 413", async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    big.set(P.MIN_PNG, 0);
    const r = await fetch(avatar, { method: "PUT", headers: { "content-type": "image/png", "x-characterly-secret": secret }, body: big });
    assert(r.status === 413, `got ${r.status}`);
  });
  await check(W, "avatar: upload lands in storage with declared type", async () => {
    const before = mock.count(c => c.url.startsWith("/storage/v1/object/companion-avatars/") && c.method === "POST");
    await fetch(avatar, { method: "PUT", headers: { "content-type": "image/webp", "x-characterly-secret": secret }, body: P.MIN_WEBP });
    assert(mock.count(c => c.url.startsWith("/storage/v1/object/companion-avatars/") && c.method === "POST") > before, "no storage PUT recorded");
  });
  await check(W, "gc: unauthorized → 401; authorized → runs", async () => {
    assert((await fetch(gc, { method: "POST" })).status === 401);
    const r = await fetch(gc, { method: "POST", headers: { "x-characterly-secret": secret } });
    assert(r.status === 200, `authorized gc → ${r.status}`);
  });
  await check(W, "track: allowlisted/malformed/oversized all 204", async () => {
    assert((await fetch(track, { method: "POST", body: '{"e":"signup_start"}' })).status === 204);
    assert((await fetch(track, { method: "POST", body: '{"e":"rm -rf /","p":"<script>"}' })).status === 204);
    assert((await fetch(track, { method: "POST", body: "not json at all" })).status === 204);
    const huge = JSON.stringify({ e: "signup_start", p: "x".repeat(2 * 1024 * 1024) });
    const t0 = Date.now();
    assert((await fetch(track, { method: "POST", body: huge })).status === 204, "2MB body failed");
    if (Date.now() - t0 > 5000) finding(W, "track parse time", `2MB body took ${Date.now() - t0}ms — unbounded request.json()`);
  });
}

async function waveInjection(base: string, mockPort: number) {
  const W = "C-ssr";
  const setFixture = async (f: unknown) =>
    fetch(`http://127.0.0.1:${mockPort}/__fixture`, { method: "POST", body: JSON.stringify(f) });

  await setFixture({ listings: [P.hostileListing(9001), P.hostileListing(9002)], ratingStats: [{ listing_id: 9001, avg: 4.9, rating_count: 7 }] });

  const ldBlocks = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // Raw payload bytes inside a quoted attribute value are inert — < > are
  // legal literal text there and the quoting " is what matters (Astro escapes
  // it to &quot;). Strip attr values before judging what's actually exposed.
  const visible = (html: string) =>
    html
      .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "")
      .replace(/="[^"]*"/g, '=""');
  const noRawBreakout = (html: string, where: string) => {
    const v = visible(html);
    assert(!v.includes("<img src=x data-pwn"), `${where}: unescaped img payload`);
    assert(!/<script[^>]*>[^<]*window\.__pwn/.test(v), `${where}: live script payload`);
    // Payload text escaped into text nodes (&lt;img...&gt;) is inert — only
    // occurrences inside REAL tags can execute. Inspect tag bodies only.
    const tags = (v.match(/<[^>]*>/g) ?? []).join(" ");
    assert(!tags.includes("__pwn"), `${where}: payload inside a live tag`);
    for (const b of ldBlocks(html)) assert(!b.includes("</"), `${where}: raw </ inside JSON-LD`);
  };

  await check(W, "hostile rows can't break /characters", async () => {
    const html = await (await fetch(base + "/characters")).text();
    noRawBreakout(html, "index");
  });
  await check(W, "hostile row can't break /characters/<id>", async () => {
    const r = await fetch(base + "/characters/9001");
    assert(r.status === 200, `detail → ${r.status}`);
    const html = await r.text();
    noRawBreakout(html, "detail");
    const v = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "").replace(/="[^"]*"/g, '=""');
    assert(v.includes("&lt;img src=x data-pwn") || !v.includes("data-pwn"), "payload neither escaped nor absent");
  });
  await check(W, "hostile rows can't break /", async () => {
    const html = await (await fetch(base + "/")).text();
    noRawBreakout(html, "landing");
  });
  await check(W, "hostile rows can't break /sitemap.xml", async () => {
    const xml = await (await fetch(base + "/sitemap.xml")).text();
    assert(!xml.includes("<img"), "markup leaked into sitemap");
  });
  await check(W, "javascript:/data: avatar_url never reaches the page", async () => {
    // safeAvatarUrl in site-shelf.ts nulls non-http(s)/relative schemes at the
    // data boundary — the hostile row's javascript: src must be gone entirely,
    // not just inert. og:image and JSON-LD image get the same guard for free.
    for (const path of ["/characters", "/characters/9001"]) {
      const html = await (await fetch(base + path)).text();
      assert(!/src="javascript:|src="data:|content="javascript:|"image":"javascript:/i.test(html), `${path}: bad scheme in a URL slot`);
      // og:image falls back to the default card when avatar_url is rejected
      assert(!html.includes('content="javascript:'), `${path}: javascript: og:image`);
    }
  });
  await check(W, "upstream JSON garbage → 503 /unavailable, not 404", async () => {
    await setFixture({ broken: true });
    try {
      const r = await fetch(base + "/characters/9001", { redirect: "manual" });
      assert(r.status === 503, `broken upstream → ${r.status} (expected 503)`);
      assert(r.headers.get("retry-after"), "missing retry-after");
      const html = await r.text();
      assert(html.includes("Back in a moment"), "not the unavailable page");
    } finally {
      await setFixture({ broken: false });
    }
  });
}

function waveAuth() {
  const W = "D-auth";
  for (const n of P.NEXT_TRICKS) {
    check(W, `next ${JSON.stringify(n.slice(0, 40))}`, () => {
      const out = safeNext(n || null);
      if (out === null) return;
      assert(out.startsWith("/") && !out.startsWith("//") && !out.includes(":"), `escaped origin: ${JSON.stringify(out)}`);
    });
  }
  check(W, "safeNext mirrors the deployed regex", () => {
    const src = readFileSync(new URL("../../src/scripts/auth.ts", import.meta.url), "utf8");
    assert(src.includes("/^\\/[^/\\\\]/"), "regex drifted from the tested mirror");
  });
  check(W, "OAuth redirectTo is origin-bound", () => {
    const src = readFileSync(new URL("../../src/scripts/auth.ts", import.meta.url), "utf8");
    assert(src.includes("origin() + (next ?? authRedirectTarget())"), "redirectTo no longer origin-prefixed");
    assert(!/redirectTo:\s*origin\(\)\s*\+\s*next\b(?!\s*\?\?)/.test(src.replace(/\s+/g, " ")), "raw next flows into redirectTo unfiltered");
  });
}

async function waveAbuse(base: string, mock: { calls: MockCall[]; count: (p: (c: MockCall) => boolean) => number }) {
  const W = "E-abuse";
  const upstream = (c: MockCall) => c.url.startsWith("/rest/v1/companion_listings") || c.url.startsWith("/rest/v1/listing_rating_stats");

  // Miss handling: the listing lookup runs before rating/catalog, so a novel
  // unknown id costs exactly one PostgREST call; a repeat inside the negative
  // cache window costs zero. A random-id crawler no longer amplifies DB load.
  mock.calls.length = 0;
  for (let i = 0; i < 15; i++) await fetch(`${base}/characters/${80000 + i}`, { redirect: "manual" });
  const missCalls = mock.count(upstream);
  if (missCalls > 15) {
    finding(W, "404 miss flood", `${missCalls} upstream calls for 15 unknown ids — rating/catalog fetched on misses. A random-id crawler amplifies DB load.`);
  } else {
    await check(W, "404 miss flood", async () => {
      mock.calls.length = 0;
      for (let i = 0; i < 5; i++) await fetch(`${base}/characters/80000`, { redirect: "manual" });
      const repeat = mock.count(upstream);
      assert(repeat === 0, `repeat misses still hit upstream: ${repeat} calls for 5 requests`);
    }, `15 misses → ${missCalls} upstream calls; repeats → 0`);
  }

  mock.calls.length = 0;
  for (let i = 0; i < 10; i++) await fetch(base + "/characters");
  const catalogCalls = mock.count(upstream);
  if (catalogCalls > 4) finding(W, "catalog cache", `${catalogCalls} upstream calls for 10 index loads — the 5-min isolate cache isn't absorbing`);
  else report(W, "catalog cache", "PASS", `${catalogCalls} upstream calls for 10 loads`);

  const t0 = Date.now();
  const big = JSON.stringify({ e: "signup_start", p: "x".repeat(4 * 1024 * 1024) });
  const r = await fetch(base + "/track", { method: "POST", body: big });
  if (r.status !== 204) finding(W, "track body size", `4MB body → ${r.status} — request.json() has no size bound`);
  else if (Date.now() - t0 > 3000) finding(W, "track body size", `4MB body parsed in ${Date.now() - t0}ms — worker-side amplification risk`);
  else report(W, "track body size", "PASS", `4MB body → 204 in ${Date.now() - t0}ms`);
}

function waveStatic() {
  const W = "F-static";
  const mig = readFileSync(new URL("../../../src/migrations.ts", import.meta.url), "utf8");
  const wrk = readFileSync(new URL("../../src/worker.ts", import.meta.url), "utf8");
  const wrangler = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");

  check(W, "claim_link_code: auth.uid + FOR UPDATE + no anonymous grant", () => {
    const body = mig.slice(mig.lastIndexOf("CREATE OR REPLACE FUNCTION public.claim_link_code"), mig.lastIndexOf("CREATE OR REPLACE FUNCTION public.claim_link_code") + 4000);
    assert(body.includes("auth.uid()"), "no uid guard");
    assert(body.includes("FOR UPDATE"), "no row lock");
    assert(mig.includes("GRANT EXECUTE ON FUNCTION public.claim_link_code(text) TO authenticated"), "grant missing");
  });
  check(W, "import_companion_card: avatar pinned to caller's card-avatars path", () => {
    assert(mig.includes("storage/v1/object/public/card-avatars/' || uid::text || '/"), "avatar pin regressed");
    assert(mig.includes("left(btrim(coalesce(p_payload->>'name'"), "name bound regressed");
  });
  check(W, "every API response passes withSecurity", () => {
    // Each API handler must be invoked inside withSecurity(...) at the
    // dispatch site — the count of call sites is not the invariant, the
    // wrapping is.
    for (const h of ["handleDiscordEvent", "handleAvatarUpload", "handleAvatarGc", "handleTrack"]) {
      assert(new RegExp(`withSecurity\\(await ${h}\\(`).test(wrk), `${h} not wrapped in withSecurity`);
    }
    // And no early return inside fetch() may bypass it except the canonical
    // redirect (a bodiless 301 where headers can't matter). The scan is
    // bounded to the export-default body — handler functions return bare
    // Responses by design; the dispatch sites wrap them.
    const start = wrk.indexOf("async fetch(");
    const fetchBody = wrk.slice(start, wrk.indexOf("\n};", start));
    const bare = [...fetchBody.matchAll(/return\s+(new Response|Response\.redirect)/g)].map(m => m[1]);
    assert(bare.every(b => b === "Response.redirect"), `bare Response return in fetch(): ${bare.join(", ")}`);
  });
  check(W, "run_worker_first covers all API paths", () => {
    for (const p of ["/discord/events", "/avatar", "/avatar/gc", "/track"]) {
      assert(wrangler.includes(`"${p}"`), `${p} not in run_worker_first`);
    }
  });
  check(W, "no service-role constant in client-reachable modules", () => {
    for (const f of ["../../src/scripts/supabase.ts", "../../src/scripts/auth.ts", "../../src/lib/config.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      assert(!src.includes("SERVICE_ROLE"), `${f} references the service key`);
    }
  });
}

// ── Orchestration ───────────────────────────────────────────────────────────

const procs: ChildProcess[] = [];
async function main() {
  const mock = await startMockSupabase();
  const { pub, sign } = await discordKeys();
  const port = 8797;
  const w = spawnWrangler(port, {
    SUPABASE_URL: `http://127.0.0.1:${mock.port}`,
    SUPABASE_SERVICE_ROLE_KEY: "testkey",
    DISCORD_APP_PUBLIC_KEY: pub,
    AVATAR_UPLOAD_SECRET: "topsecret",
  });
  procs.push(w.proc);
  const wPrev = spawnWrangler(8798, { NOINDEX: "1", CANONICAL_REDIRECT: "off" });
  procs.push(wPrev.proc);

  console.log("booting workers…");
  await waitFor(`${w.base}/`);
  await waitFor(`${wPrev.base}/`);

  await waveEdge(w.base, port);
  await waveApi(w.base, mock, sign);
  await waveInjection(w.base, mock.port);
  waveAuth();
  await waveAbuse(w.base, mock);
  waveStatic();

  await check("A-edge", "NOINDEX=1 → x-robots-tag: noindex", async () => {
    const r = await fetch(`${wPrev.base}/characters`);
    assert(r.headers.get("x-robots-tag") === "noindex", `got ${r.headers.get("x-robots-tag")}`);
  });

  let fails = 0, findings = 0;
  let wave = "";
  for (const r of results) {
    if (r.wave !== wave) { wave = r.wave; console.log(`\n── ${wave} ──`); }
    const mark = { PASS: "✔", FAIL: "✖", FINDING: "◆", INFO: "ℹ" }[r.status];
    console.log(`${mark} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.status === "FAIL") fails++;
    if (r.status === "FINDING") findings++;
  }
  console.log(`\n${results.length} checks — ${fails} failed, ${findings} findings`);
  return fails ? 1 : 0;
}

main()
  .then(code => process.exitCode = code)
  .catch(e => { console.error("harness error:", e); process.exitCode = 2; })
  .finally(async () => {
    await Promise.all(procs.map(killTree));
    setTimeout(() => process.exit(), 500).unref();
  });
