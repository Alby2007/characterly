import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "characterly-website",
    compatibilityDate: "2026-10-06",
    observability: { enabled: true },
    assets: {
      // Multi-page app — real .html files exist for every route.
      notFoundHandling: "404-page",
    },
  },
});
