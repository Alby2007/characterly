import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
  server: { port: 5173, host: "localhost" },
  // With a worker entrypoint configured, the plugin splits the build into a
  // `client` environment (the static site → assets) and the worker env —
  // top-level `build` would apply the HTML inputs to the worker bundle.
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            main: fileURLToPath(new URL("./index.html", import.meta.url)),
            account: fileURLToPath(new URL("./account.html", import.meta.url)),
            dashboard: fileURLToPath(new URL("./dashboard.html", import.meta.url)),
            terms: fileURLToPath(new URL("./terms.html", import.meta.url)),
            privacy: fileURLToPath(new URL("./privacy.html", import.meta.url)),
            security: fileURLToPath(new URL("./security.html", import.meta.url)),
            safety: fileURLToPath(new URL("./safety.html", import.meta.url)),
            notFound: fileURLToPath(new URL("./404.html", import.meta.url)),
          },
        },
      },
    },
  },
});
