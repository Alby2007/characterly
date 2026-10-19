import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "characterly-website",
    compatibilityDate: "2026-10-06",
    entrypoint: "./worker.ts",
    observability: { enabled: true },
    env: {
      // First-party site analytics — dataset auto-creates on deploy.
      // Datapoints carry event name/path/referer host only: no IPs, cookies,
      // or user ids (see worker.ts trackAe).
      ANALYTICS: bindings.analyticsEngineDataset({ name: "characterly_site" }),
    },
    assets: {
      // Multi-page app — real .html files exist for every route.
      notFoundHandling: "404-page",
    },
  },
});
