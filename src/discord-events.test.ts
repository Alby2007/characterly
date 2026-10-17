import assert from "node:assert/strict";
import test from "node:test";
import { verifyDiscordSignature, parseDiscordEvent } from "./discord-events.js";
import { scopedCommandDefinitions, SERVER_ONLY_COMMANDS, commandDefinitions } from "./commands.js";

// Ed25519 signature + envelope parsing for POST /discord/events — same code
// runs in the website worker; these tests exercise it in Node.

async function makeKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("hex");
  return { pair, publicKeyHex: pub };
}
async function sign(key: CryptoKey, msg: string): Promise<string> {
  const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(msg));
  return Buffer.from(sig).toString("hex");
}

test("verifyDiscordSignature accepts a valid signature, rejects tampering", async () => {
  const { pair, publicKeyHex } = await makeKeyPair();
  const timestamp = "1730000000";
  const body = JSON.stringify({ type: 1, event: { type: "APPLICATION_AUTHORIZED", data: {} } });
  const good = await sign(pair.privateKey, timestamp + body);
  assert.equal(await verifyDiscordSignature(publicKeyHex, good, timestamp, body), true);
  // Tampered body / wrong timestamp / garbage signature → all false, no throw.
  assert.equal(await verifyDiscordSignature(publicKeyHex, good, timestamp, body + " "), false);
  assert.equal(await verifyDiscordSignature(publicKeyHex, good, "1730000001", body), false);
  assert.equal(await verifyDiscordSignature(publicKeyHex, "zz", timestamp, body), false);
});

test("parseDiscordEvent maps envelopes to actions", async () => {
  assert.deepEqual(parseDiscordEvent(JSON.stringify({ type: 0 })), { kind: "ping" });
  assert.equal(parseDiscordEvent("not json").kind, "ignored");
  assert.equal(parseDiscordEvent(JSON.stringify({ type: 1, event: { type: "ENTITLEMENT_CREATE", data: { user: { id: "u1" } } } })).kind, "ignored");
  // Guild install (integration_type 0) → ignored (announce card covers guilds).
  assert.equal(parseDiscordEvent(JSON.stringify({
    type: 1, event: { type: "APPLICATION_AUTHORIZED", data: { integration_type: 0, user: { id: "u1" } } },
  })).kind, "ignored");
  // Missing user id → ignored.
  assert.equal(parseDiscordEvent(JSON.stringify({
    type: 1, event: { type: "APPLICATION_AUTHORIZED", data: { integration_type: 1 } },
  })).kind, "ignored");

  const auth = parseDiscordEvent(JSON.stringify({
    type: 1,
    event: { type: "APPLICATION_AUTHORIZED", timestamp: "2025-01-01T00:00:00Z", data: { integration_type: 1, user: { id: "u42" }, scopes: ["applications.commands"] } },
  }));
  assert.equal(auth.kind, "install");
  if (auth.kind === "install") { assert.equal(auth.userId, "u42"); assert.equal(auth.event, "authorized"); }

  const deauth = parseDiscordEvent(JSON.stringify({
    type: 1, event: { type: "APPLICATION_DEAUTHORIZED", data: { user: { id: "u42" } } },
  }));
  assert.equal(deauth.kind, "install");
  if (deauth.kind === "install") assert.equal(deauth.event, "deauthorized");
});

test("scopedCommandDefinitions scopes server-only to guild, others to guild+DM", async () => {
  const scoped = scopedCommandDefinitions(commandDefinitions) as Array<any>;
  for (const def of scoped) {
    if (SERVER_ONLY_COMMANDS.has(def.name)) {
      assert.deepEqual(def.integrationTypes, [0], `${def.name} should be guild-install only`);
      assert.deepEqual(def.contexts, [0], `${def.name} should be guild-context only`);
    } else {
      assert.deepEqual(def.integrationTypes, [0, 1], `${def.name} should install to guild + user`);
      assert.deepEqual(def.contexts, [0, 1], `${def.name} should run in guild + bot DM`);
    }
  }
  // Companion must be DM-invocable — it's the onboarding surface.
  const companion = scoped.find(d => d.name === "companion");
  assert.deepEqual(companion?.contexts, [0, 1]);
});
