// Security rules that must not regress: the post-auth `next` redirect only
// follows same-origin paths, and /track only records allowlisted events.
import { test } from "node:test";
import assert from "node:assert/strict";

// Mirrors safeNext() in src/scripts/auth.ts (kept DOM-free there for reuse).
const safeNext = (next: string | null): string | null =>
  next && /^\/[^/\\]/.test(next) && !next.includes(":") ? next : null;

test("next: same-origin paths pass", () => {
  assert.equal(safeNext("/dashboard"), "/dashboard");
  assert.equal(safeNext("/dashboard?welcome=1#billing"), "/dashboard?welcome=1#billing");
});

test("next: open-redirect shapes are refused", () => {
  for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "/x:y", "", null, "dashboard"]) {
    assert.equal(safeNext(bad as string | null), null, String(bad));
  }
});

test("auth.ts carries the same rule", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../scripts/auth.ts", import.meta.url), "utf8");
  assert.ok(src.includes(`if (next && /^\\/[^/\\\\]/.test(next) && !next.includes(":")) return next;`));
});

test("worker: /track allowlist is exactly the funnel events", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../worker.ts", import.meta.url), "utf8");
  const m = src.match(/TRACKED_EVENTS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m);
  const names = m[1].split(",").map(s => s.trim().replace(/"/g, ""));
  assert.deepEqual(names.sort(), ["checkout_click", "discord_signin_click", "link_attempt", "signup_done", "signup_start"]);
});

test("worker: API paths are exempt from the canonical redirect", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../worker.ts", import.meta.url), "utf8");
  assert.ok(src.includes('if (!api && env.CANONICAL_REDIRECT !== "off" && url.hostname !== CANONICAL_HOST'));
});
