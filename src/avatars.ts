import { config } from "./config.js";
import { inc } from "./metrics.js";
import { logError } from "./secrets.js";

const TIMEOUT_MS = 8_000;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Companion avatars must outlive their source — Discord CDN attachment URLs
 *  expire, pasted links rot. Every avatar_url set-point pipes the image
 *  through the worker's PUT /avatar into public Supabase Storage. Secret
 *  unset or any failure → null, and callers keep the source URL. */
async function uploadAvatar(bytes: Uint8Array, contentType: string): Promise<string | null> {
  if (!config.avatarUploadSecret) return null;
  try {
    const res = await fetch(`${config.siteUrl.replace(/\/+$/, "")}/avatar`, {
      method: "PUT",
      headers: { "content-type": contentType, "x-characterly-secret": config.avatarUploadSecret },
      body: bytes.buffer as ArrayBuffer,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { url?: string };
    return typeof json.url === "string" && /^https:\/\//.test(json.url) ? json.url : null;
  } catch (e) {
    inc("avatar.rehost_error");
    logError("avatar upload failed", e);
    return null;
  }
}

export async function rehostAvatar(sourceUrl: string): Promise<string | null> {
  if (!config.avatarUploadSecret) return null;
  try {
    const src = await fetch(sourceUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!src.ok) return null;
    const type = (src.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(type)) return null;
    const buf = new Uint8Array(await src.arrayBuffer());
    if (!buf.byteLength || buf.byteLength > config.imageMaxBytes) return null;
    return uploadAvatar(buf, type);
  } catch (e) {
    inc("avatar.rehost_error");
    logError("avatar fetch failed", e);
    return null;
  }
}

/** Local asset → same lane (seed cover files under assets/marketplace/). */
export async function uploadAvatarFile(path: string): Promise<string | null> {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const type = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  if (!ALLOWED_TYPES.has(type)) return null;
  try {
    const buf = await (await import("node:fs/promises")).readFile(path);
    return uploadAvatar(new Uint8Array(buf), type);
  } catch { return null; }
}
