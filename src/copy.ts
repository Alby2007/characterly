import { config } from "./config.js";

/** Canonical "get a linked account" tail — one builder so the dozen-plus
 *  gate surfaces can't drift apart. Leads with the zero-step path: the
 *  site's "Continue with Discord" button auto-links via the
 *  sync_discord_identity trigger (no code, no /link round-trip). Email
 *  signups keep the /link code exchange as the fallback. No trailing
 *  period — callers attach their own context clause. */
export function linkSteps(): string {
  return `create a free account at ${config.siteUrl}/account — **Continue with Discord** links you automatically, or sign up with email and run \`/link\` here`;
}
