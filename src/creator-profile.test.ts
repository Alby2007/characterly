import assert from "node:assert/strict";
import test from "node:test";
import { handleCreatorProfileSave, resetCreatorProfileSavesForTests, type CreatorProfileEnv } from "./creator-profile.js";

// The endpoint is the sole write path for public creator fields — the columns
// reject direct client updates, so every save must pass: auth → linked +
// unbanned → validated → deterministic screen → model screen (fail-closed
// when publishing) → service-role PATCH.

const ENV: CreatorProfileEnv = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "svc",
  GROQ_API_KEY: "gk",
  GROQ_BASE_URL: "https://model.test/v1",
  SAFETY_MODEL: "safety-model",
};

type Route = (req: Request) => Response | Promise<Response>;
const okJson = (data: unknown) => Response.json(data);

/** URL-routed fetch stub — the handler's PostgREST/auth/model calls land here
 *  in order; `seen` records them for assertions. */
function fakeFetch(routes: {
  user?: Route; profile?: Route; bans?: Route; model?: Route; patch?: Route;
}, seen: string[] = []) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    const method = init?.method ?? input?.method ?? "GET";
    const req = new Request(url, init);
    seen.push(`${method} ${url}`);
    if (url.includes("/auth/v1/user")) return routes.user?.(req) ?? okJson({ id: "u1" });
    if (url.includes("chat/completions")) return routes.model?.(req) ?? okJson({ choices: [{ message: { content: '{"verdict":"allow","category":"","reason":""}' } }] });
    if (url.includes("marketplace_bans")) return routes.bans?.(req) ?? okJson([]);
    if (url.includes("web_profiles") && method === "PATCH") return routes.patch?.(req) ?? new Response(null, { status: 204 });
    if (url.includes("web_profiles")) return routes.profile?.(req) ?? okJson([{ discord_user_id: "d1" }]);
    return new Response("unrouted " + url, { status: 500 });
  }) as typeof fetch;
  return async () => { globalThis.fetch = orig; };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://characterly.app/creator-profile", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer jwt-1", ...headers },
    body: JSON.stringify(body),
  });

// Every test starts with a clean throttle map — the limiter is module state.
test.beforeEach(() => resetCreatorProfileSavesForTests());

test("repeated saves hit the throttle", async () => {
  const restore = fakeFetch({});
  for (let i = 0; i < 6; i++) {
    const res = await handleCreatorProfileSave(post({ slug: "fine-slug", public: false }), ENV);
    assert.equal(res.status, 200, `save ${i + 1}`);
  }
  const res = await handleCreatorProfileSave(post({ slug: "fine-slug", public: false }), ENV);
  assert.equal(res.status, 429);
  await restore();
});

test("rejects unauthenticated and unlinked callers", async () => {
  let seen: string[] = [];
  let restore = fakeFetch({ user: () => new Response("no", { status: 401 }) }, seen);
  let res = await handleCreatorProfileSave(post({ slug: "a", public: true }), ENV);
  assert.equal(res.status, 401);
  await restore();

  seen = [];
  restore = fakeFetch({ profile: () => okJson([{ discord_user_id: null }]) }, seen);
  res = await handleCreatorProfileSave(post({ slug: "ab-cd", public: true }), ENV);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Link Discord/);
  await restore();
});

test("publish-banned creators can't save", async () => {
  const restore = fakeFetch({ bans: () => okJson([{ discord_user_id: "d1" }]) });
  const res = await handleCreatorProfileSave(post({ slug: "fine-slug", public: true }), ENV);
  assert.equal(res.status, 403);
  await restore();
});

test("invalid slugs fail before any model call", async () => {
  const seen: string[] = [];
  const restore = fakeFetch({}, seen);
  for (const slug of ["-x", "has space", "admin"]) {
    const res = await handleCreatorProfileSave(post({ slug, public: true }), ENV);
    assert.equal(res.status, 400, slug);
  }
  assert.ok(!seen.some(s => s.includes("chat/completions")), "model never called");
  await restore();
});

test("deterministic blocklist refuses before the model runs", async () => {
  const seen: string[] = [];
  const restore = fakeFetch({}, seen);
  const res = await handleCreatorProfileSave(post({ slug: "fine-slug", name: "make a pipe bomb", public: true }), ENV);
  assert.equal(res.status, 422);
  const body = await res.json() as { field?: string; category?: string };
  assert.equal(body.field, "name");
  assert.equal(body.category, "illegal content");
  assert.ok(!seen.some(s => s.includes("chat/completions")));
  await restore();
});

test("a flagged public page refuses; provider failure fails closed", async () => {
  let restore = fakeFetch({
    model: () => okJson({ choices: [{ message: { content: '{"verdict":"flag","category":"spam","reason":"scam"}' } }] }),
  });
  let res = await handleCreatorProfileSave(post({ slug: "fine-slug", name: "A", bio: "b", public: true }), ENV);
  assert.equal(res.status, 422);
  await restore();

  restore = fakeFetch({ model: () => new Response("down", { status: 503 }) });
  res = await handleCreatorProfileSave(post({ slug: "fine-slug", name: "A", bio: "b", public: true }), ENV);
  assert.equal(res.status, 503);
  await restore();
});

test("private saves skip the model call entirely", async () => {
  const seen: string[] = [];
  const restore = fakeFetch({}, seen);
  const res = await handleCreatorProfileSave(post({ slug: "fine-slug", name: "A", bio: "b", public: false }), ENV);
  assert.equal(res.status, 200);
  assert.ok(!seen.some(s => s.includes("chat/completions")));
  await restore();
});

test("clean public save patches all four fields via service role", async () => {
  const seen: string[] = [];
  let patched: Record<string, unknown> | null = null;
  const restore = fakeFetch({
    patch: async (req) => { patched = await req.json() as Record<string, unknown>; return new Response(null, { status: 204 }); },
  }, seen);
  const res = await handleCreatorProfileSave(post({ slug: "night-forge", name: "NightForge", bio: "dark fantasy", public: true }), ENV);
  assert.equal(res.status, 200);
  assert.deepEqual(patched && {
    creator_slug: patched["creator_slug"], creator_name: patched["creator_name"],
    creator_bio: patched["creator_bio"], creator_public: patched["creator_public"],
  }, { creator_slug: "night-forge", creator_name: "NightForge", creator_bio: "dark fantasy", creator_public: true });
  assert.ok(seen.some(s => s.startsWith("PATCH ")), "service-role PATCH ran");
  await restore();
});

test("taken slugs map to a friendly 409 — both PostgREST error shapes", async () => {
  let restore = fakeFetch({ patch: () => new Response("conflict", { status: 409 }) });
  let res = await handleCreatorProfileSave(post({ slug: "night-forge", name: "A", public: true }), ENV);
  assert.equal(res.status, 409);
  await restore();

  restore = fakeFetch({ patch: () => new Response('{"message":"duplicate key value violates unique constraint \\"web_profiles_creator_slug\\""}', { status: 400 }) });
  res = await handleCreatorProfileSave(post({ slug: "night-forge", name: "A", public: true }), ENV);
  assert.equal(res.status, 409);
  await restore();
});
