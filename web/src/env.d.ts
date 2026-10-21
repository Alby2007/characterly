/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

// `wrangler types --include-runtime=false` keeps the Workers globals out of
// the DOM's namespace (HTMLRewriter's Element clashes with the client's DOM).
// The generated file still references a few binding types; declare the shapes
// we actually use, plus the secrets that never live in wrangler.jsonc.
interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

interface AnalyticsEngineDataset {
  writeDataPoint(event: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

interface ExecutionContext<Props = unknown> {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

declare module "cloudflare:workers" {
  export const env: Env & {
    DISCORD_APP_PUBLIC_KEY?: string;
    SUPABASE_URL?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    AVATAR_UPLOAD_SECRET?: string;
    NOINDEX?: string;
  };
}
