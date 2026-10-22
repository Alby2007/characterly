// ── House ops ────────────────────────────────────────────────────────────────
// The bot is also the private operator of OUR community server and its own
// host — member ops, deterministic automod, channel layout, and host health.
// Implementation lives under src/ops/; this barrel keeps the import surface
// (`import ... from "./ops.js"`) stable for index.ts, commands.ts, and tests.

export * from "./ops/shared.js";
export * from "./ops/members.js";
export * from "./ops/automod.js";
export * from "./ops/tickets.js";
export * from "./ops/adoptees.js";
export * from "./ops/deploy.js";
export * from "./ops/layout.js";
export * from "./ops/host.js";
