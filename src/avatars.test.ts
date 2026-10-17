import assert from "node:assert/strict";
import test from "node:test";
import { rehostAvatar, uploadAvatarFile } from "./avatars.js";
import { config } from "./config.js";

// The avatar lane never throws — every failure shape resolves to null so
// callers keep the source URL. fetch + config are stubbed per test.

function withFetch<T>(fn: (input: unknown, init?: RequestInit) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  return run().finally(() => { globalThis.fetch = orig; });
}

test("rehostAvatar: secret unset → null, no fetch", async () => {
  const saved = config.avatarUploadSecret;
  config.avatarUploadSecret = undefined;
  try {
    await withFetch(async () => { throw new Error("must not fetch"); }, async () => {
      assert.equal(await rehostAvatar("https://cdn.discordapp.com/ephemeral.png"), null);
      assert.equal(await uploadAvatarFile("wren.jpg"), null);
    });
  } finally { config.avatarUploadSecret = saved; }
});

test("rehostAvatar: source fetch + worker PUT → durable URL", async () => {
  const saved = { s: config.avatarUploadSecret, u: config.siteUrl };
  config.avatarUploadSecret = "shh";
  config.siteUrl = "https://site.example/";
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  try {
    await withFetch(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://cdn.discordapp.com/ephemeral.png") {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png; charset=binary" } });
      }
      if (url === "https://site.example/avatar") {
        return Response.json({ url: "https://proj.supabase.co/storage/v1/object/public/companion-avatars/abc.png" });
      }
      return new Response("unexpected", { status: 500 });
    }, async () => {
      const out = await rehostAvatar("https://cdn.discordapp.com/ephemeral.png");
      assert.equal(out, "https://proj.supabase.co/storage/v1/object/public/companion-avatars/abc.png");
      assert.equal(calls.length, 2, "one source fetch + one worker PUT");
      const put = calls[1];
      assert.equal(put.url, "https://site.example/avatar");
      assert.equal(put.init?.method, "PUT");
      const headers = put.init?.headers as Record<string, string>;
      assert.equal(headers["x-characterly-secret"], "shh");
      assert.equal(headers["content-type"], "image/png", "content-type params stripped");
    });
  } finally { config.avatarUploadSecret = saved.s; config.siteUrl = saved.u; }
});

test("rehostAvatar: non-image/oversized/failed sources → null, never throws", async () => {
  const saved = { s: config.avatarUploadSecret, u: config.siteUrl, b: config.imageMaxBytes };
  config.avatarUploadSecret = "shh";
  config.siteUrl = "https://site.example";
  config.imageMaxBytes = 10;
  try {
    await withFetch(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }), async () => {
      assert.equal(await rehostAvatar("https://x.example/page"), null, "non-image type refused");
    });
    await withFetch(async () => new Response(new Uint8Array(64), { status: 200, headers: { "content-type": "image/png" } }), async () => {
      assert.equal(await rehostAvatar("https://x.example/big.png"), null, "over IMAGE_MAX_BYTES refused");
    });
    await withFetch(async () => new Response("gone", { status: 404 }), async () => {
      assert.equal(await rehostAvatar("https://x.example/gone.png"), null, "failed source fetch refused");
    });
    await withFetch(async () => { throw new Error("dns exploded"); }, async () => {
      assert.equal(await rehostAvatar("https://x.example/throw.png"), null, "a throw resolves to null");
    });
  } finally { config.avatarUploadSecret = saved.s; config.siteUrl = saved.u; config.imageMaxBytes = saved.b; }
});

test("uploadAvatarFile: non-image extension → null without touching disk", async () => {
  const saved = config.avatarUploadSecret;
  config.avatarUploadSecret = "shh";
  try {
    assert.equal(await uploadAvatarFile("cover.txt"), null);
    assert.equal(await uploadAvatarFile("noext"), null);
  } finally { config.avatarUploadSecret = saved; }
});
