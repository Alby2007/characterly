// Discord Webhook Events — signature verification + envelope parsing for the
// POST /discord/events endpoint (website worker). Pure TS + WebCrypto so the
// same code runs in the Worker and in Node tests — same shared-module pattern
// as charcard.ts / chathist.ts.
//
// Discord signs every webhook-event POST with Ed25519:
//   X-Signature-Ed25519  — hex signature over (timestamp + body)
//   X-Signature-Timestamp
// Endpoints that return 2xx to an invalid signature get removed by Discord's
// health check, so verification failure must be a 401.

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Verify the Discord signature headers against the raw request body. */
export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex) as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const msg = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signatureHex) as BufferSource,
      msg as BufferSource,
    );
  } catch {
    return false; // malformed key/signature is a verify failure, not a crash
  }
}

export type DiscordEventAction =
  | { kind: "ping" }
  | { kind: "install"; userId: string; event: "authorized" | "deauthorized"; meta: Record<string, unknown> }
  | { kind: "ignored" };

/** Parse the verified body into what we care about: user-install auth events.
 *  Guild installs (integration_type 0) are ignored — announceIfNeeded covers
 *  guilds. PINGs and everything else get their own kind for clean 204s. */
export function parseDiscordEvent(body: string): DiscordEventAction {
  let envelope: any;
  try { envelope = JSON.parse(body); } catch { return { kind: "ignored" }; }
  if (envelope?.type === 0) return { kind: "ping" };
  const ev = envelope?.event;
  if (envelope?.type !== 1 || typeof ev?.type !== "string") return { kind: "ignored" };
  const data = ev.data ?? {};
  const userId = typeof data.user?.id === "string" ? data.user.id : null;
  if (!userId) return { kind: "ignored" };
  if (ev.type === "APPLICATION_AUTHORIZED" && data.integration_type === 1) {
    return { kind: "install", userId, event: "authorized", meta: { event_type: ev.type, timestamp: ev.timestamp, scopes: data.scopes ?? [], data } };
  }
  if (ev.type === "APPLICATION_DEAUTHORIZED") {
    return { kind: "install", userId, event: "deauthorized", meta: { event_type: ev.type, timestamp: ev.timestamp, data } };
  }
  return { kind: "ignored" };
}
