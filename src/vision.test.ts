import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { qualifyingImages, formatImageContext, IMAGE_MAX_PER_MESSAGE } from "./vision.js";
import { Brain, type LlmClient } from "./brain.js";
import type { MessageEvent } from "./types.js";

const att = (contentType: string | null, size = 100, url = "https://cdn.discordapp.com/attachments/1/2/x.png") =>
  ({ url, contentType, size });

const ev = (content: string): MessageEvent => ({
  guildId: "g1", channelId: "c1", messageId: "m1", authorId: "u1", authorName: "Alice",
  content, createdAt: new Date(), mentionsBot: false,
});

// ── qualifyingImages ─────────────────────────────────────────────────────────

test("qualifyingImages keeps image/* under the byte cap, skips everything else", () => {
  const list = [
    att("image/png"),
    att("image/gif"),             // animated → skipped
    att("video/mp4"),
    att(null),                    // unknown type → skipped
    att("image/webp"),
    att("application/pdf"),
    att("image/jpeg", 5_000_000), // over a 4MB cap → skipped
  ];
  const out = qualifyingImages(list, 4_000_000);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(a => a.contentType), ["image/png", "image/webp"]);
  const ct: string = out[0].contentType; // narrowed to non-null on qualified items
  assert.equal(ct, "image/png");
});

test("qualifyingImages caps at maxCount, keeping earliest attachments", () => {
  const list = Array.from({ length: 8 }, (_, i) => att("image/png", 100, `u${i}`));
  const out = qualifyingImages(list, 4_000_000);
  assert.equal(out.length, IMAGE_MAX_PER_MESSAGE);
  assert.deepEqual(out.map(a => a.url), ["u0", "u1", "u2"]);
});

test("formatImageContext frames descriptions as bot observation", () => {
  assert.equal(formatImageContext([], "Alice"), "");
  assert.match(formatImageContext(["a dog"], "Alice"), /Alice attached image — content observed by the bot: "a dog"/);
  assert.match(formatImageContext(["a", "b"], "Alice"), /attached images — .*"a"; "b"/);
});

// ── describeImage + prompt injection via stub client ─────────────────────────

function stubClient(capture: { chat?: any; responses?: any }) {
  return {
    responses: { create: async (p: any) => { capture.responses = p; return { output_text: '{"memories":[],"relationships":[]}' }; } },
    chat: { completions: { create: async (p: any) => { capture.chat = p; return { choices: [{ message: { content: '{"description":"a golden retriever on a beach","category":"photo"}' } }] }; } } },
  } as LlmClient;
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// describeImage fetches the attachment itself (data-URI is the only portable
// image_url shape) — the fetcher is injectable because the real one is
// SSRF-guarded via safeRequest, which correctly refuses loopback test servers.
const okFetch = async () => ({ buf: PNG, mime: "image/png" });

test("describeImage fetches bytes, sends a data URI with strict json_schema", async () => {
  {
    const capture: { chat?: any } = {};
    const brain = new Brain("k", "m", undefined, stubClient(capture));
    const out = await brain.describeImage({ url: "https://cdn.example/x.png", contextText: "my dog" }, "vision-model", undefined, okFetch);
    assert.equal(out.description, "a golden retriever on a beach");
    assert.equal(out.category, "photo");
    assert.equal(capture.chat.model, "vision-model");
    const parts = capture.chat.messages[0].content;
    assert.equal(parts[0].type, "text");
    assert.match(parts[0].text, /do not guess at the identity/i);
    assert.match(parts[0].text, /my dog/); // caption passed for disambiguation
    assert.equal(parts[1].type, "image_url");
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(capture.chat.response_format.type, "json_schema");
    assert.deepEqual(capture.chat.response_format.json_schema.schema.required, ["description", "category"]);
  }
});

test("describeImage propagates fetch failures from the guarded fetcher", async () => {
  const brain = new Brain("k", "m", undefined, stubClient({}));
  await assert.rejects(
    brain.describeImage({ url: "https://cdn.discordapp.com/x.png" }, "m", undefined, async () => { throw new Error("image fetch failed: 404"); }),
    /image fetch failed/
  );
  await assert.rejects(
    brain.describeImage({ url: "https://cdn.discordapp.com/x.png", maxBytes: 1000 }, "m", undefined, async () => { throw new Error("image over byte cap: 99999999"); }),
    /over byte cap/
  );
});

test("describeImage uses the override client when a second provider is passed", async () => {
  const main: { chat?: any } = {};
  const other: { chat?: any } = {};
  const brain = new Brain("k", "m", undefined, stubClient(main));
  await brain.describeImage({ url: "https://cdn.discordapp.com/x.png" }, "vision-model", stubClient(other), okFetch);
  assert.ok(other.chat, "override client should receive the call");
  assert.equal(main.chat, undefined, "main client should not be called");
});

test("extractMemories carries the observation frame only when imageContext is passed", async () => {
  const capture: { chat?: any } = {};
  const brain = new Brain("k", "m", undefined, stubClient(capture));
  await brain.extractMemories(ev("look at this"), undefined, undefined,
    'Alice attached image — content observed by the bot: "a dog on a beach"');
  const input: string = capture.chat.messages[0].content;
  assert.match(input, /content observed by the bot: "a dog on a beach"/);
  assert.match(input, /direct_observation or uncertain_inference/);
  assert.match(input, /not the author's words/);

  const capture2: { chat?: any } = {};
  const brain2 = new Brain("k", "m", undefined, stubClient(capture2));
  await brain2.extractMemories(ev("plain text"));
  assert.doesNotMatch(capture2.chat.messages[0].content, /observed by the bot/);
});

test("reply appends imageContext to the situation", async () => {
  const capture: { chat?: any } = {};
  const brain = new Brain("k", "m", undefined, stubClient(capture));
  await brain.reply(ev("wdyt of this"), [], [], [], [], "plain-model",
    false, "bot-1", undefined, undefined,
    'Alice attached image — content observed by the bot: "a dog on a beach"');
  assert.match(capture.chat.messages[0].content, /content observed by the bot: "a dog on a beach"/);
});

// BYOK providers without structured output (Ollama, llama.cpp, many proxies)
// reject response_format outright — the chatCreate seam must strip it and
// retry bare, the same contract chatContent has always had. describeImage
// stands in for every batch method routed through the seam.
test("describeImage retries without response_format when the provider rejects it", async () => {
  const sent: any[] = [];
  const flaky = {
    responses: { create: async () => ({ output_text: "{}" }) },
    chat: { completions: { create: async (p: any) => {
      sent.push(p);
      if (p.response_format) throw new Error("400 Bad Request: response_format not supported");
      return { choices: [{ message: { content: '{"description":"a dog","category":"photo"}' } }] };
    } } },
  } as LlmClient;
  const brain = new Brain("k", "m", undefined, flaky);
  const out = await brain.describeImage({ url: "https://cdn.example/x.png" }, "m", undefined, okFetch);
  assert.equal(out.description, "a dog");
  assert.equal(sent.length, 2, "strict attempt then one bare retry");
  assert.equal(sent[1].response_format, undefined, "retry drops response_format");
});

// A non-format rejection must NOT fall back — retrying a 401/quota error
// without response_format just doubles the failure and hides the real cause.
test("describeImage does not retry on non-format errors", async () => {
  const flaky = {
    responses: { create: async () => ({ output_text: "{}" }) },
    chat: { completions: { create: async () => { throw new Error("401 unauthorized"); } } },
  } as LlmClient;
  const brain = new Brain("k", "m", undefined, flaky);
  await assert.rejects(
    brain.describeImage({ url: "https://cdn.example/x.png" }, "m", undefined, okFetch),
    /401/,
  );
});
