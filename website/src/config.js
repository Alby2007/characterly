// Single source of truth for outbound links — change them here, not in markup.
export const LINKS = {
  // Bot invite: applications.commands + bot scopes, with the permissions the
  // bot needs (view/send/read history/manage webhooks/embeds/attach/react).
  addToDiscord:
    "https://discord.com/oauth2/authorize?client_id=1549171765056639048&scope=bot%20applications.commands&permissions=536988736",
  discord: "https://discord.gg/vCjQ9v3md",
  github: "https://github.com/Alby2007/characterly",
  privacy: "https://github.com/Alby2007/characterly/blob/main/PRIVACY.md",
  terms: "https://github.com/Alby2007/characterly/blob/main/TERMS.md",
  security: "https://github.com/Alby2007/characterly/blob/main/SECURITY.md",
};

// Supabase client config. The publishable key is public by design — access is
// enforced by row-level security on the database, not by secrecy of the key.
export const SUPABASE_URL = "https://tfukkoektmsrolykliop.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_996kFzgS7sTm4u2FQmOTBw_FXca4Dyd";

// Flip to true once the Discord provider is enabled in Supabase Auth
// (client id + secret from the Discord developer portal).
export const DISCORD_OAUTH_ENABLED = true;
