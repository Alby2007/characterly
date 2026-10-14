import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import { createBrainResolver, detectProviderFromKey } from "./brains.js";
import { encryptSecret } from "./secrets.js";

config.keyEncryptionSecret = "test-master-passphrase";

const ENV = { envKey: "env-key", envModel: "env-model", envBaseUrl: "https://env/v1" };
const enc = (key: string) => encryptSecret(key);
const row = (key: string, baseUrl: string | null = null) => ({ keyEnc: enc(key), baseUrl });

function resolver(getKey: (g: string) => Promise<{ keyEnc: Buffer; baseUrl: string | null } | null>, requireGuildKeys = false) {
  return createBrainResolver({ getKey, ...ENV, requireGuildKeys });
}

test("guild key beats the env fallback", async () => {
  let calls = 0;
  const { brainFor } = resolver(async () => { calls++; return row("guild-key"); });
  const brain = await brainFor("g1");
  assert.ok(brain);
  // Second resolution is a cache hit — no second getKey call.
  assert.equal(await brainFor("g1"), brain);
  assert.equal(calls, 1);
});

test("no guild key → env fallback", async () => {
  const { brainFor } = resolver(async () => null);
  assert.ok(await brainFor("g1"));
});

test("requireGuildKeys blocks the env fallback → dormant", async () => {
  const { brainFor } = resolver(async () => null, true);
  assert.equal(await brainFor("g1"), null);
  // requireGuildKeys doesn't block a real guild key — only the env fallback.
  const keyed = resolver(async () => row("guild-key"), true);
  assert.ok(await keyed.brainFor("g1"));
});

test("undecryptable row → null (dormant), not a crash", async () => {
  const bad = Buffer.from("not-a-valid-gcm-blob-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const { brainFor } = resolver(async () => ({ keyEnc: bad, baseUrl: null }));
  assert.equal(await brainFor("g1"), null);
});

test("unverified guild row revalidates once and marks validated on success", async () => {
  const marked: string[] = [];
  const seen: Array<{ key: string; baseUrl: string }> = [];
  const { brainFor } = createBrainResolver({
    getKey: async () => ({ ...row("guild-key", "https://guild.example/v1"), validatedAt: null }),
    ...ENV, requireGuildKeys: false,
    markValidated: async g => { marked.push(g); },
    revalidate: async (key, baseUrl) => { seen.push({ key, baseUrl }); return true; },
  });
  await brainFor("g1");
  await new Promise(r => setTimeout(r, 0)); // flush the fire-and-forget revalidate chain
  assert.deepEqual(seen, [{ key: "guild-key", baseUrl: "https://guild.example/v1" }]);
  assert.deepEqual(marked, ["g1"]);
});

test("already-validated rows skip revalidation; failed revalidation doesn't mark", async () => {
  const marked: string[] = [];
  let revalidateCalls = 0;
  const validated = createBrainResolver({
    getKey: async () => ({ ...row("guild-key"), validatedAt: "2026-01-01T00:00:00Z" }),
    ...ENV, requireGuildKeys: false,
    markValidated: async g => { marked.push(g); },
    revalidate: async () => { revalidateCalls++; return true; },
  });
  await validated.brainFor("g1");
  await new Promise(r => setTimeout(r, 0));
  assert.equal(revalidateCalls, 0);

  const failing = createBrainResolver({
    getKey: async () => ({ ...row("guild-key"), validatedAt: null }),
    ...ENV, requireGuildKeys: false,
    markValidated: async g => { marked.push(g); },
    revalidate: async () => false,
  });
  await failing.brainFor("g2");
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(marked, []);
});

test("invalidate forces re-resolution (key rotation)", async () => {
  let current: { keyEnc: Buffer; baseUrl: string | null } | null = row("key-v1");
  const { brainFor, invalidate } = resolver(async () => current);
  const first = await brainFor("g1");
  current = row("key-v2");
  assert.equal(await brainFor("g1"), first); // cached
  invalidate("g1");
  const second = await brainFor("g1");
  assert.ok(second);
  assert.notEqual(second, first);
});

test("detectProviderFromKey auto-detects Groq, OpenRouter, OpenAI, and xAI when Base URL is blank", () => {
  const groq = detectProviderFromKey("gsk_abc123456", null);
  assert.equal(groq.provider, "Groq");
  assert.equal(groq.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(groq.autoDetected, true);

  const openrouter = detectProviderFromKey("sk-or-v1-xyz", "");
  assert.equal(openrouter.provider, "OpenRouter");
  assert.equal(openrouter.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(openrouter.autoDetected, true);

  const openai = detectProviderFromKey("sk-proj-123456", undefined);
  assert.equal(openai.provider, "OpenAI");
  assert.equal(openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(openai.model, "gpt-4o-mini");
  assert.equal(openai.autoDetected, true);

  const xai = detectProviderFromKey("xai-key-999", null);
  assert.equal(xai.provider, "xAI");
  assert.equal(xai.baseUrl, "https://api.x.ai/v1");
  assert.equal(xai.model, "grok-3-mini");
  assert.equal(xai.autoDetected, true);

  const custom = detectProviderFromKey("gsk_abc123456", "https://custom.llm.example/v1");
  assert.equal(custom.provider, "Custom");
  assert.equal(custom.baseUrl, "https://custom.llm.example/v1");
  assert.equal(custom.autoDetected, false);
});

test("user keys (dm:<userId>) power DMs, brainForUser in servers, and guild plumbing via getGuildOwnerIds", async () => {
  const keys = new Map<string, { keyEnc: Buffer; baseUrl: string | null }>([
    ["dm:u-alice", row("gsk_alice_personal_key")],
  ]);
  const meteredScopes: string[] = [];
  const { brainFor, brainForUser } = createBrainResolver({
    getKey: async scopeId => keys.get(scopeId) ?? null,
    getGuildOwnerIds: async guildId => (guildId === "g-hangout" ? ["u-alice"] : []),
    envKey: "",
    envModel: "openai/gpt-oss-120b",
    envBaseUrl: "https://api.groq.com/openai/v1",
    requireGuildKeys: true,
    meter: (scopeId, client) => {
      meteredScopes.push(scopeId);
      return client;
    },
  });

  // 1. DM scope uses Alice's personal key even when envKey is empty
  const dmBrain = await brainFor("dm:u-alice");
  assert.ok(dmBrain, "dm:u-alice resolves from Alice's personal key");

  // 2. When Alice's companion speaks in g-hangout, brainForUser uses Alice's key and meters against g-hangout
  const compBrain = await brainForUser("u-alice", "g-hangout");
  assert.ok(compBrain, "brainForUser resolves Alice's personal key for server speech");

  // 3. Server background plumbing in g-hangout resolves via summoned companion owner (u-alice) with zero server key
  const guildPlumbingBrain = await brainFor("g-hangout");
  assert.ok(guildPlumbingBrain, "guild with summoned companion resolves brain without a server key");

  // 4. Empty guild with no summoned companions and no envKey stays dormant
  assert.equal(await brainFor("g-empty"), null);
  assert.deepEqual(meteredScopes, ["dm:u-alice", "g-hangout", "g-hangout"]);
});
