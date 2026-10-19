// Single source of truth for outbound links — change them here, not in markup.
export const LINKS = {
  // Discord-provided install link — scopes/permissions come from the app's
  // default install settings (guild: bot+commands w/ perms; user: commands),
  // so the authorize page offers BOTH "Add to Server" and "Add to My Apps".
  // Pinning scope=bot here would force guild-only and hide the DM option.
  addToDiscord: "https://discord.com/oauth2/authorize?client_id=1549171765056639048",
  discord: "https://discord.gg/tNGCeaTPtC",
  // First-party charter pages — they render the repo's .md files at build.
  privacy: "/privacy",
  terms: "/terms",
  security: "/security",
  safety: "/safety",
};

// Current Terms/Privacy version for clickwrap consent — keep in sync with
// TERMS_VERSION in src/ops.ts. Bumping re-prompts website users at the
// dashboard gate AND Discord members at verify.
export const TERMS_VERSION = 1;

// Supabase client config. The publishable key is public by design — access is
// enforced by row-level security on the database, not by secrecy of the key.
export const SUPABASE_URL = "https://tfukkoektmsrolykliop.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_996kFzgS7sTm4u2FQmOTBw_FXca4Dyd";

// Flip to true once the Discord provider is enabled in Supabase Auth
// (client id + secret from the Discord developer portal).
export const DISCORD_OAUTH_ENABLED = true;
