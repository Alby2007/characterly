// Single source of truth for outbound links, public runtime constants and
// prices. Change values here, never in markup.

export const SITE_ORIGIN = "https://characterly.app";

export const LINKS = {
  // Discord-provided install link: scopes come from the app's default install
  // settings, so the authorize page offers both "Add to Server" and "Add to My
  // Apps". Pinning scope=bot here would hide the DM option.
  addToDiscord: "https://discord.com/oauth2/authorize?client_id=1549171765056639048",
  // The Characterly hub server. The bot's src/site-shelf.ts DISCORD_INVITE
  // mirrors this until that module's templates are retired.
  discord: "https://discord.gg/tNGCeaTPtC",
} as const;

// Clickwrap version. Keep in sync with TERMS_VERSION in the bot's src/ops.ts:
// bumping it re-prompts website users at the dashboard gate AND Discord
// members at verify.
export const TERMS_VERSION = 1;

// The publishable key is public by design; row-level security enforces access.
// The service-role key never appears in client code.
// PUBLIC_* envs override at build/dev time — used by the red-team harness to
// point the whole client stack at its mock Supabase (and usable for staging).
export const SUPABASE_URL = import.meta.env?.PUBLIC_SUPABASE_URL ?? "https://tfukkoektmsrolykliop.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = import.meta.env?.PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_996kFzgS7sTm4u2FQmOTBw_FXca4Dyd";

// Plans and prices, mirrored from the Stripe catalog (supabase/functions/
// create-checkout + stripe-webhook, docs/operations.md → Billing). Every page
// and JSON-LD block reads these; never hardcode a price in markup.
export const PLANS = {
  free: { dailyTokens: 30, adoptionSlots: 1 },
  premium: { dailyTokens: 150, monthly: "7.99", yearly: "79.99" },
} as const;

export const PACKS = [
  { product: "pack_750", tokens: 750, price: "4.99" },
  { product: "pack_2500", tokens: 2500, price: "9.99" },
  { product: "pack_7500", tokens: 7500, price: "24.99" },
] as const;
