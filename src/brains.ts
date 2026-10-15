import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import { Brain, type LlmClient } from "./brain.js";
import { decryptSecret, errorText } from "./secrets.js";
import { inc } from "./metrics.js";
import { isPrivateAddress, safeLookup } from "./tools.js";

// Per-guild base URLs are untrusted input — a guild admin can point them
// anywhere, and every call carries that guild's API key. isSafeUrl +
// the /setup DNS check are input-time gates only; this dispatcher runs the
// validation INSIDE the socket connect path, so a hostname that later flips
// to a private/internal address (rebinding) still can't turn the bot into an
// internal-network request primitive. Only applied to guild-chosen URLs —
// the operator's env URL is trusted by definition (self-hosters may
// legitimately point at LAN/local model servers).
const guildDispatcher = new Agent({ connect: { lookup: safeLookup } });

/** fetch that re-validates DNS at connect time — for calls carrying a
 * guild's own key to a guild-chosen base URL. IP literals are checked here
 * because undici skips lookup() for them and would otherwise connect raw. */
export const guardedLlmFetch: typeof fetch = (input, init) => {
  const raw = typeof input === "string" || input instanceof URL ? String(input) : (input as Request).url;
  const host = new URL(raw).hostname;
  if (isPrivateAddress(host)) return Promise.reject(new Error(`blocked: ${host} is a private address`));
  return undiciFetch(input as any, { ...(init as any), dispatcher: guildDispatcher }) as unknown as Promise<Response>;
};

/**
 * Auto-detect provider, base URL, and default model from an API key prefix
 * when the user leaves the optional Base URL field blank.
 */
export function detectProviderFromKey(
  key: string,
  explicitBaseUrl?: string | null,
  defaultBaseUrl = "https://api.groq.com/openai/v1",
  defaultModel = "openai/gpt-oss-120b",
  explicitModel?: string | null,
): { provider: string; baseUrl: string; model: string; autoDetected: boolean } {
  const pinned = explicitModel?.trim() || null;
  const custom = explicitBaseUrl?.trim();
  if (custom) {
    return { provider: "Custom", baseUrl: custom, model: pinned ?? defaultModel, autoDetected: false };
  }
  const k = key.trim();
  if (k.startsWith("gsk_")) {
    return {
      provider: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: pinned ?? (defaultModel || "openai/gpt-oss-120b"),
      autoDetected: true,
    };
  }
  if (k.startsWith("sk-or-")) {
    return {
      provider: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: pinned ?? "openai/gpt-oss-120b",
      autoDetected: true,
    };
  }
  if (k.startsWith("xai-")) {
    return {
      provider: "xAI",
      baseUrl: "https://api.x.ai/v1",
      model: pinned ?? "grok-3-mini",
      autoDetected: true,
    };
  }
  if (k.startsWith("sk-")) {
    return {
      provider: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: pinned ?? "gpt-4o-mini",
      autoDetected: true,
    };
  }
  return { provider: "Default", baseUrl: defaultBaseUrl, model: pinned ?? defaultModel, autoDetected: false };
}

/**
 * Brain resolver (User-first BYOK).
 *
 * In Characterly, API keys belong to users (`dm:<userId>` in `guild_keys`),
 * while the bot in a Discord server acts as the shared plumbing:
 *   1. For `dm:<userId>` (or `brainForUser(userId, meterScope)`):
 *      - User's personal key (`dm:<userId>`) -> decrypt + auto-detect provider/model
 *      - Operator env key fallback
 *   2. For a guild scope (`guildId` background plumbing):
 *      - Direct key row if present (`getKey(guildId)`)
 *      - Any active summoned companion owner's personal key (`getGuildOwnerIds`)
 *      - Operator env key fallback (unless `requireGuildKeys` is true)
 *      - `null` (dormant)
 */
export function createBrainResolver(opts: {
  getKey: (scopeId: string) => Promise<{ keyEnc: Buffer; baseUrl: string | null; model?: string | null; validatedAt?: string | null } | null>;
  envKey: string;
  envModel: string;
  envBaseUrl: string;
  requireGuildKeys: boolean;
  /** Optional lookup of active summoned companion owner user IDs in a guild so
   *  server background plumbing can run on summoned companion owners' keys. */
  getGuildOwnerIds?: (guildId: string) => Promise<string[]>;
  /** Persist "key proven good" for rows stored while the provider was
   * unreachable at /setup time. Optional — revalidation is skipped without it. */
  markValidated?: (scopeId: string) => Promise<void>;
  /** Re-check a stored-unverified key; injectable for tests. */
  revalidate?: (key: string, baseUrl: string) => Promise<boolean>;
  /** Wraps every constructed client — the budget meter hooks in here so ALL
   * key sources pay the scope's daily cap. */
  meter?: (scopeId: string, client: LlmClient) => LlmClient;
  /** Wraps only env-key (hosted) clients — the global hosted-spend circuit
   *  breaker hooks in here so BYOK calls never count against it. */
  meterHosted?: (scopeId: string, client: LlmClient) => LlmClient;
}) {
  const cache = new Map<string, Brain | null>();
  // Scopes whose resolved brain came from the operator env key (the "hosted
  // lane") — credit charges and the global hosted cap apply only to these.
  const hostedScopes = new Set<string>();
  const hostedWrap = (scopeId: string, c: LlmClient): LlmClient =>
    (opts.meterHosted ?? opts.meter ?? ((_s, x) => x))(scopeId, c);
  // Which key scopes each guild-scope cache entry resolved through. A dm:
  // invalidation only needs to evict guilds whose brain came from that user's
  // key — or from the env fallback, which a newly-added key could displace.
  const guildProvenance = new Map<string, Set<string>>();

  function buildFromRow(
    keyScopeId: string,
    meterScopeId: string,
    row: { keyEnc: Buffer; baseUrl: string | null; model?: string | null; validatedAt?: string | null },
  ): Brain | null {
    const wrap = (c: LlmClient): LlmClient => (opts.meter ? opts.meter(meterScopeId, c) : c);
    try {
      const key = decryptSecret(row.keyEnc);
      const detected = detectProviderFromKey(key, row.baseUrl, opts.envBaseUrl, opts.envModel, row.model);
      const baseUrl = detected.baseUrl;
      const model = detected.model;
      const brain = row.baseUrl
        ? new Brain(key, model, baseUrl, wrap(new OpenAI({ apiKey: key, baseURL: baseUrl, fetch: guardedLlmFetch })))
        : new Brain(key, model, baseUrl, wrap(new OpenAI({ apiKey: key, ...(baseUrl ? { baseURL: baseUrl } : {}) })));
      if (!row.validatedAt && opts.markValidated && opts.revalidate) {
        void opts
          .revalidate(key, baseUrl)
          .then(ok => {
            if (ok) return opts.markValidated!(keyScopeId);
          })
          .catch(() => {
            /* validation is best-effort — the Brain still works */
          });
      }
      return brain;
    } catch (error) {
      inc("brain.decrypt_failed");
      console.warn(`guild_keys decrypt failed for ${keyScopeId} — scope dormant until /setup re-runs`, errorText(error));
      return null;
    }
  }

  async function brainFor(guildId: string): Promise<Brain | null> {
    if (cache.has(guildId)) return cache.get(guildId)!;
    const wrap = (c: LlmClient): LlmClient => (opts.meter ? opts.meter(guildId, c) : c);

    let brain: Brain | null = null;
    let hosted = false;
    if (guildId.startsWith("dm:")) {
      const userRow = await opts.getKey(guildId);
      if (userRow) {
        brain = buildFromRow(guildId, guildId, userRow);
      } else if (opts.envKey) {
        hosted = true;
        brain = new Brain(
          opts.envKey,
          opts.envModel,
          opts.envBaseUrl,
          hostedWrap(guildId, new OpenAI({ apiKey: opts.envKey, ...(opts.envBaseUrl ? { baseURL: opts.envBaseUrl } : {}) })),
        );
      }
      cache.set(guildId, brain);
      if (hosted) hostedScopes.add(guildId); else hostedScopes.delete(guildId);
      return brain;
    }

    const row = await opts.getKey(guildId);
    if (row) {
      brain = buildFromRow(guildId, guildId, row);
      guildProvenance.set(guildId, new Set([guildId])); // served by its own key — dm: changes can't touch it
    } else {
      const consulted = new Set<string>();
      if (opts.getGuildOwnerIds) {
        for (const ownerId of await opts.getGuildOwnerIds(guildId)) {
          const ownerScope = `dm:${ownerId}`;
          consulted.add(ownerScope);
          const ownerRow = await opts.getKey(ownerScope);
          if (ownerRow) {
            brain = buildFromRow(ownerScope, guildId, ownerRow);
            if (brain) break;
          }
        }
      }
      guildProvenance.set(guildId, consulted);
      if (!brain && opts.envKey && !opts.requireGuildKeys) {
        hosted = true;
        brain = new Brain(
          opts.envKey,
          opts.envModel,
          opts.envBaseUrl,
          hostedWrap(guildId, new OpenAI({ apiKey: opts.envKey, ...(opts.envBaseUrl ? { baseURL: opts.envBaseUrl } : {}) })),
        );
      }
    }

    cache.set(guildId, brain);
    if (hosted) hostedScopes.add(guildId); else hostedScopes.delete(guildId);
    return brain;
  }

  /**
   * Resolve a Brain specifically for a user (used when a user's companion
   * speaks in a server or DM): uses the user's personal key (`dm:<userId>`)
   * first, then falls back to `brainFor(meterScope)`.
   */
  async function brainForUser(userId: string, meterScopeId?: string): Promise<Brain | null> {
    const userScope = `dm:${userId}`;
    const targetMeter = meterScopeId ?? userScope;
    const cacheKey = `user:${userId}@${targetMeter}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey)!;

    const userRow = await opts.getKey(userScope);
    if (userRow) {
      const brain = buildFromRow(userScope, targetMeter, userRow);
      cache.set(cacheKey, brain);
      hostedScopes.delete(cacheKey);
      return brain;
    }
    const fallback = await brainFor(targetMeter);
    cache.set(cacheKey, fallback);
    // Mirror the meter scope's provenance — a user without a key is hosted iff
    // the scope serving them resolved through the env key.
    if (hostedScopes.has(targetMeter)) hostedScopes.add(cacheKey); else hostedScopes.delete(cacheKey);
    return fallback;
  }

  /** True when this scope's brain rides the operator env key — credit charges
   *  and the global hosted cap apply to hosted lanes only. */
  function isHostedScope(scopeId: string): boolean {
    return hostedScopes.has(scopeId);
  }

  /** True when the brain serving userId (via brainForUser) is hosted — checks
   *  the user: cacheKey, which brainForUser always populates (keyed user →
   *  absent; env fallback → present iff the meter scope itself is hosted).
   *  Deliberately does NOT consult the meter scope: a BYOK owner in a hosted
   *  guild is still a BYOK lane. */
  function isHostedUserBrain(userId: string, meterScopeId?: string): boolean {
    const meter = meterScopeId ?? `dm:${userId}`;
    return hostedScopes.has(`user:${userId}@${meter}`);
  }

  function invalidate(scopeId: string): void {
    cache.delete(scopeId);
    hostedScopes.delete(scopeId);
    guildProvenance.delete(scopeId);
    for (const k of [...cache.keys()]) {
      if (!k.startsWith("user:")) continue;
      // user cache keys look like `user:<uid>@<meterScope>` — evict entries
      // that are this user's key, or were metered against this scope.
      if ((scopeId.startsWith("dm:") && k.startsWith(`user:${scopeId.slice(3)}@`)) || k.endsWith(`@${scopeId}`)) {
        cache.delete(k);
        hostedScopes.delete(k);
      }
    }
    if (scopeId.startsWith("dm:")) {
      // Evict only guild entries that consulted this user's key, or fell back
      // to env/no-key (empty provenance) where the new key could now serve.
      for (const [guild, prov] of guildProvenance) {
        if (prov.size === 0 || prov.has(scopeId)) {
          guildProvenance.delete(guild);
          cache.delete(guild);
          hostedScopes.delete(guild);
        }
      }
    }
  }

  return { brainFor, brainForUser, invalidate, isHostedScope, isHostedUserBrain };
}

export type BrainResolver = ReturnType<typeof createBrainResolver>;
