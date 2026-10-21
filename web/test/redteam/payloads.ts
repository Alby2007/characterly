// The attack catalog. Every string below is ammunition — nothing here is a
// "test fixture", it is what a hostile listing author / import would send.

/** Script/markup breakouts. `_pwn` markers let assertions prove execution
 *  never happened (window.__pwn stays undefined) and the element never lands. */
export const XSS = {
  scriptClose: `</script><img src=x data-pwn onerror=window.__pwn=1>`,
  attrBreak: `"><img src=x data-pwn onerror=window.__pwn=1>`,
  svgOnload: `<svg/onload=window.__pwn=1>`,
  // JSON-LD is JSON.stringify + </→<\/ — this must stay inert in the block.
  ldBreakout: `</script><script>window.__pwn=1</script>`,
  template: "${window.__pwn=1}",
  doubleEncoded: `&lt;img src=x onerror=window.__pwn=1&gt;`,
  lineSep: "a\u2028b\u2029c",
  htmlComment: `<!--<img src=x data-pwn>-->`,
  jsScheme: `javascript:window.__pwn=1`,
  dataScheme: `data:text/html,<script>window.__pwn=1</script>`,
  mentionUser: `<@123456789012345678>`,
  mentionChannel: `<#123456789012345678>`,
  mentionEveryone: `@everyone`,
  bidi: "safe\u202Etrever\u202Cname",
};

/** A listing row saturated with hostile fields — the mock serves it through
 *  the real PostgREST→SSR pipeline. Fields mirror the RawListing shape. */
export function hostileListing(id = 9001) {
  return {
    id,
    name: XSS.scriptClose,
    tagline: XSS.attrBreak,
    voice_persona: XSS.svgOnload + "\n\n" + XSS.ldBreakout,
    core_traits: [XSS.scriptClose, XSS.jsScheme, XSS.mentionEveryone, XSS.bidi, "t5", "t6", "t7", "t8"],
    creator_tags: [XSS.attrBreak, XSS.mentionUser, XSS.dataScheme, XSS.mentionChannel],
    backstory: XSS.ldBreakout + "\n\n" + XSS.doubleEncoded + "\n\n" + XSS.lineSep,
    greeting: `*${XSS.scriptClose}* ${XSS.attrBreak}`,
    avatar_url: `javascript:window.__pwn=1`,
    add_count: 42,
    updated_at: `2026-01-01T00:00:00Z${XSS.scriptClose}`,
  };
}

/** Path shapes that must never produce an off-origin Location or a second
 *  canonical variant. `fetch` normalizes some before the wire — the host/raw
 *  cases go through a raw-socket helper instead. */
export const PATH_TRICKS: { path: string; expect: "clean-301" | "404-or-200" }[] = [
  { path: "//evil.com/x", expect: "404-or-200" },
  { path: "/\\evil.com", expect: "404-or-200" },
  { path: "/%2f%2fevil.com", expect: "404-or-200" },
  { path: "/%5c%5cevil.com", expect: "404-or-200" },
  { path: "/%2e%2e/", expect: "404-or-200" },
  { path: "/%00", expect: "404-or-200" },
  { path: "/characters/", expect: "clean-301" },
  { path: "/characters//", expect: "clean-301" },
  { path: "/characters/1/", expect: "clean-301" },
  { path: "/@evil.com", expect: "404-or-200" },
  { path: "/\t/evil", expect: "404-or-200" },
];

/** `?next=` values — every one must resolve to a same-origin path or the
 *  /dashboard fallback, never an off-origin navigation. */
export const NEXT_TRICKS = [
  "//evil.com", "/\\evil.com", "%2f%2fevil.com", "javascript:alert(1)",
  "/x:y", "data:text/html,x", "\\\\evil.com", "/\tevil", "https://evil.com",
  "", "/ /", "/" + "a".repeat(4096),
];

/** Host header tricks — tested over a raw socket so undici can't sanitize. */
export const HOST_TRICKS = [
  "characterly.app.evil.com",
  "evil.com",
  "WWW.CHARACTERLY.APP",
  "characterly.app.",
  "notcharacterly.app",
  "characterly-app.workers.dev",
];

/** Tiny valid images, one per declared family — just enough bytes for the
 *  sniffer plus a plausible continuation. */
export const MIN_PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
export const MIN_JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
export const MIN_WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
export const MIN_GIF89 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0]);
export const MIN_GIF87 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 1, 0, 1, 0, 0x80, 0, 0]);
export const RIFF_AVI = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]);

/** The /avatar declared-vs-actual matrix. */
export const AVATAR_CASES: { name: string; declared: string | null; bytes: Uint8Array | null; want: number }[] = [
  { name: "png passes", declared: "image/png", bytes: MIN_PNG, want: 200 },
  { name: "jpeg passes", declared: "image/jpeg", bytes: MIN_JPG, want: 200 },
  { name: "jpg alias passes", declared: "image/jpg", bytes: MIN_JPG, want: 200 },
  { name: "webp passes", declared: "image/webp", bytes: MIN_WEBP, want: 200 },
  { name: "gif89 passes", declared: "image/gif", bytes: MIN_GIF89, want: 200 },
  { name: "gif87 passes", declared: "image/gif", bytes: MIN_GIF87, want: 200 },
  { name: "declared jpeg, actually png → 415", declared: "image/jpeg", bytes: MIN_PNG, want: 415 },
  { name: "declared png, actually jpeg → 415", declared: "image/png", bytes: MIN_JPG, want: 415 },
  { name: "declared png, actually html → 415", declared: "image/png", bytes: new TextEncoder().encode("<html><script>1</script>"), want: 415 },
  { name: "RIFF but AVI not WEBP → 415", declared: "image/webp", bytes: RIFF_AVI, want: 415 },
  { name: "declared bmp → 415", declared: "image/bmp", bytes: MIN_PNG, want: 415 },
  { name: "uppercase IMAGE/PNG passes", declared: "IMAGE/PNG", bytes: MIN_PNG, want: 200 },
  { name: "charset param tolerated", declared: "image/png; charset=x", bytes: MIN_PNG, want: 200 },
  { name: "no content-type → 415", declared: null, bytes: MIN_PNG, want: 415 },
  { name: "empty body → 413", declared: "image/png", bytes: new Uint8Array(0), want: 413 },
  { name: "text/plain → 415", declared: "text/plain", bytes: new TextEncoder().encode("hello"), want: 415 },
];
