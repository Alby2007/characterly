import assert from "node:assert/strict";
import test from "node:test";
import { rehostAvatar, uploadAvatarFile } from "./avatars.js";
import { config } from "./config.js";

// The avatar lane never throws — every failure shape resolves to null so
// callers keep the source URL. The source fetcher is injected per test (the
// real fetchImageBytes is SSRF-guarded and correctly refuses loopback, so it
// can't run against a local stub server); globalThis.fetch is stubbed only
// for the worker PUT.

type FetchImage = (url: string, maxBytes: number) => Promise<{ buf: Buffer; mime: string }>;

function withFetch<T>(fn: (input: unknown, init?: RequestInit) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  return run().finally(() => { globalThis.fetch = orig; });
}

test("rehostAvatar: secret unset → null, no fetch", async () => {
  const saved = config.avatarUploadSecret;
  config.avatarUploadSecret = undefined;
  try {
    const fetchImage: FetchImage = async () => { throw new Error("must not fetch"); };
    await withFetch(async () => { throw new Error("must not fetch"); }, async () => {
      assert.equal(await rehostAvatar("https://cdn.discordapp.com/ephemeral.png", fetchImage), null);
      assert.equal(await uploadAvatarFile("wren.jpg"), null);
    });
  } finally { config.avatarUploadSecret = saved; }
});

test("rehostAvatar: source fetch + worker PUT → durable URL", async () => {
  const saved = { s: config.avatarUploadSecret, u: config.siteUrl };
  config.avatarUploadSecret = "shh";
  config.siteUrl = "https://site.example/";
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  // Subarray keeps a non-zero byteOffset into a larger allocation — the PUT
  // must send the view's bytes, never the whole underlying buffer.
  const buf = Buffer.from([9, 9, 9, 9, 1, 2, 3, 9, 9]).subarray(4, 7);
  const fetchImage: FetchImage = async () => ({ buf, mime: "image/png" });
  try {
    await withFetch(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://site.example/avatar") {
        return Response.json({ url: "https://proj.supabase.co/storage/v1/object/public/companion-avatars/abc.png" });
      }
      return new Response("unexpected", { status: 500 });
    }, async () => {
      const out = await rehostAvatar("https://cdn.discordapp.com/ephemeral.png", fetchImage);
      assert.equal(out, "https://proj.supabase.co/storage/v1/object/public/companion-avatars/abc.png");
      assert.equal(calls.length, 1, "only the worker PUT rides fetch");
      const put = calls[0];
      assert.equal(put.url, "https://site.example/avatar");
      assert.equal(put.init?.method, "PUT");
      const headers = put.init?.headers as Record<string, string>;
      assert.equal(headers["x-characterly-secret"], "shh");
      assert.equal(headers["content-type"], "image/png", "content-type params stripped");
      assert.deepEqual([...Buffer.from(put.init?.body as Uint8Array)], [1, 2, 3], "PUT body is the view's exact bytes");
    });
  } finally { config.avatarUploadSecret = saved.s; config.siteUrl = saved.u; }
});

test("rehostAvatar: non-image/oversized/failed sources → null, never throws", async () => {
  const saved = { s: config.avatarUploadSecret, u: config.siteUrl, b: config.imageMaxBytes };
  config.avatarUploadSecret = "shh";
  config.siteUrl = "https://site.example";
  config.imageMaxBytes = 10;
  try {
    await withFetch(async () => new Response("unexpected", { status: 500 }), async () => {
      const html: FetchImage = async () => ({ buf: Buffer.from("<html>"), mime: "text/html" });
      assert.equal(await rehostAvatar("https://x.example/page", html), null, "non-image type refused");
      // Over the cap even when the fetcher doesn't enforce it.
      const big: FetchImage = async () => ({ buf: Buffer.alloc(64), mime: "image/png" });
      assert.equal(await rehostAvatar("https://x.example/big.png", big), null, "over IMAGE_MAX_BYTES refused");
      const fail: FetchImage = async () => { throw new Error("image fetch failed: 404"); };
      assert.equal(await rehostAvatar("https://x.example/gone.png", fail), null, "failed source fetch refused");
      assert.equal(await rehostAvatar("https://x.example/throw.png", fail), null, "a throw resolves to null");
    });
  } finally { config.avatarUploadSecret = saved.s; config.siteUrl = saved.u; config.imageMaxBytes = saved.b; }
});

test("rehostAvatar: real fetchImageBytes refuses unsafe source URLs pre-connect", async () => {
  // The SSRF fix — isSafeUrl runs inside fetchImageBytes on every hop, so
  // private/link-local/loopback sources (and non-http schemes) resolve to
  // null without a packet leaving for the target. Redirect-chain coverage of
  // the same guard lives in tools.test.ts / the visit_url tests.
  const saved = config.avatarUploadSecret;
  config.avatarUploadSecret = "shh";
  try {
    for (const url of [
      "http://127.0.0.1:8080/a.png",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/x.png",
      "http://[::1]/a.png",
      "file:///etc/passwd",
      "not a url",
    ]) {
      assert.equal(await rehostAvatar(url), null, `${url} refused`);
    }
  } finally { config.avatarUploadSecret = saved; }
});

test("uploadAvatarFile: non-image extension → null without touching disk", async () => {
  const saved = config.avatarUploadSecret;
  config.avatarUploadSecret = "shh";
  try {
    assert.equal(await uploadAvatarFile("cover.txt"), null);
    assert.equal(await uploadAvatarFile("noext"), null);
  } finally { config.avatarUploadSecret = saved; }
});
