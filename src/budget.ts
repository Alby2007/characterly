import { AsyncLocalStorage } from "node:async_hooks";
import type { LlmClient } from "./brain.js";
import type { MemoryStore } from "./database.js";

// ── Per-guild LLM budget ──────────────────────────────────────────────────────
// Every LLM call a guild makes — regardless of whether it rides the guild's
// own BYOK key or the operator's env key — flows through the LlmClient seam
// (Brain's private client). Wrapping that client here makes the cap universal:
// extraction, replies, triage, profiles, contests all pay the same toll.
// The counter lives in guild_usage keyed by UTC day; chargeLlmCall increments
// atomically under the row lock, so concurrent calls can't overshoot.

export class BudgetExceeded extends Error {
  constructor(
    public readonly guildId: string,
    public readonly cap: number,
  ) {
    super(`guild ${guildId} hit the daily LLM cap (${cap})`);
    this.name = "BudgetExceeded";
  }
}

/** A job paused because the payer's token balance ran dry — same
 * park-until-UTC-midnight semantics as BudgetExceeded (the daily grant lands
 * then), but a distinct name so logs read "wallet empty", not "LLM cap". */
export class CreditsExhausted extends BudgetExceeded {
  constructor(guildId: string, public readonly balance: number) {
    super(guildId, 0);
    this.name = "CreditsExhausted";
    this.message = `${guildId} paused — token balance is empty (${balance})`;
  }
}

export function isBudgetExceeded(error: unknown): error is BudgetExceeded {
  return error instanceof BudgetExceeded;
}

/**
 * Proxy an LlmClient so every responses.create / chat.completions.create
 * charges the guild's daily counter first. Over cap → BudgetExceeded before
 * the request leaves the process. The cap is re-read per call through
 * getCap() (settings() is cached 60s — acceptable softness for a daily bound,
 * and it means /server limits takes effect without a resolver invalidation).
 */
export function meteredClient(inner: LlmClient, opts: {
  guildId: string;
  store: MemoryStore;
  getCap: () => Promise<number>;
}): LlmClient {
  const charge = async () => {
    const cap = await opts.getCap();
    const result = await opts.store.chargeLlmCall(opts.guildId, cap);
    if (!result.ok) throw new BudgetExceeded(opts.guildId, result.cap);
  };
  return {
    responses: { create: (params: unknown) => charge().then(() => inner.responses.create(params)) },
    chat: { completions: { create: (params: unknown) => charge().then(() => inner.chat.completions.create(params)) } },
  };
}

// ── Background vs live hosted spend ───────────────────────────────────────────
// Deferred cognition (extract/journal/summary jobs, the triage sweep, nightly
// maintenance) and live replies share one Brain per scope — and the hosted
// lane's fleet breaker. Without a split, a heavy background day pushes
// hosted:global past the free-lane shed point and live chat goes dark first.
// Background work runs inside runAsBackground(); hosted clients wrapped with
// backgroundCapped() additionally charge `hosted:background`, whose cap is a
// fraction of the fleet cap — the remainder is reserved for live turns.
const backgroundCtx = new AsyncLocalStorage<true>();

export function runAsBackground<T>(fn: () => Promise<T>): Promise<T> {
  return backgroundCtx.run(true, fn);
}

export function inBackground(): boolean {
  return backgroundCtx.getStore() === true;
}

export function backgroundCapped(inner: LlmClient, opts: {
  store: MemoryStore;
  getCap: () => Promise<number>;
}): LlmClient {
  const capped = meteredClient(inner, { guildId: "hosted:background", store: opts.store, getCap: opts.getCap });
  const pick = () => (inBackground() ? capped : inner);
  return {
    responses: { create: (params: unknown) => pick().responses.create(params) },
    chat: { completions: { create: (params: unknown) => pick().chat.completions.create(params) } },
  };
}
