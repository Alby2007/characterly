// Characterly website — Astro on Cloudflare Workers.
// Static by default; the shelf, sitemap and any on-demand page opt out with
// `export const prerender = false`. The worker entry (src/worker.ts) owns the
// API endpoints, canonical redirect, security headers and analytics, and hands
// every page request to Astro's handler.
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: "https://characterly.app",
  trailingSlash: "ignore",
  // No server sessions: auth is Supabase in the browser. Keeps the SSR bundle
  // lean and stops the adapter provisioning a KV namespace.
  session: false,
  adapter: cloudflare({ imageService: "passthrough" }),
  build: { format: "file", inlineStylesheets: "never" },
  vite: {
    // Never inline scripts — the CSP allows script-src 'self' only.
    build: { assetsInlineLimit: 0 },
    // The card/chat parsers and shelf data layer are shared with the bot
    // (../src); one source, tested by the bot suite.
    server: { fs: { allow: [".."] } },
  },
});
