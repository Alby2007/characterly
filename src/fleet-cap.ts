import type { MemoryStore } from "./database.js";
import { inc } from "./metrics.js";
import { logError } from "./secrets.js";

// ── Revenue-aware fleet capacity ──────────────────────────────────────────────
// The hosted circuit breaker was a static env var: a viral spike shed the free
// lane at 90% of a number chosen at deploy time — quieting companions exactly
// when exposure (and premium conversion) peaked. This module makes the cap
// revenue-bounded instead: active premium subscriptions fund an additive bonus
// on top of the static base. Viral usage alone never raises the cap; only
// money already committed does. Every failure path decays to the base cap —
// the worst case is today's static behavior, never an unguarded fleet.
//
// One provider feeds every consumer (hard cap, pressure shed, safety screen,
// background share) so the four numbers can't drift apart.

export type FleetCapConfig = {
  /** Static floor — HOSTED_DAILY_LLM_CAP. <= 0 is a deliberate freeze; the
   *  bonus never unlocks a frozen fleet. */
  baseDailyCap: number;
  /** Conservative blended daily revenue per premium sub. Yearly-normalized
   *  ($79.99/365 ≈ $0.22), not monthly — web_profiles.plan has no interval
   *  column, so the low rate is the honest default. */
  premiumDailyRevenueUsd: number;
  /** Blended cost estimate per hosted LLM call — operator-set, biased high. */
  costPerHostedCallUsd: number;
  /** Estimation error eats margin, not runway (0–1). */
  safetyFactor: number;
  /** Absolute ceiling on the bonus — a mispriced formula can never exceed
   *  base + maxBonusCalls. */
  maxBonusCalls: number;
};

export type FleetCapBreakdown = {
  base: number;
  /** This cycle's formula result — may differ from effective − base while
   *  the day-ratchet holds a higher cap. */
  bonus: number;
  /** base + bonus (or base when frozen) before the day-ratchet. */
  computed: number;
  /** The cap actually enforced — computed ratcheted per UTC day. */
  effective: number;
  premiumCount: number;
  usedToday: number;
  maxBonus: number;
};

/** Hosted calls/day funded by premium revenue. Pure — no IO, always finite,
 *  clamped [0, maxBonusCalls]. Any non-positive input or config yields 0. */
export function computeFleetBonus(premiumCount: number, cfg: FleetCapConfig): number {
  if (!Number.isFinite(premiumCount) || premiumCount <= 0) return 0;
  const { premiumDailyRevenueUsd: rev, costPerHostedCallUsd: cost, safetyFactor: safety, maxBonusCalls: ceiling } = cfg;
  if (!(rev > 0) || !(cost > 0) || !(safety > 0) || !(ceiling > 0)) return 0;
  const raw = Math.floor(premiumCount * rev / cost * safety);
  return Math.max(0, Math.min(raw, Math.floor(ceiling)));
}

type FleetStore = Pick<MemoryStore, "premiumAccountCount" | "hostedUsageToday"> & {
  /** Durable day-ratchet — optional so a minimal store decays to the
   *  in-memory ratchet (pre-v65 behavior) instead of failing. */
  fleetCapHighWater?: (day: string) => Promise<number | null>;
  setFleetCapHighWater?: (day: string, cap: number) => Promise<void>;
};

// 60s matches the settings/account cache precedent — webhook-driven plan
// flips land within a minute, fresh enough for a daily budget.
const REFRESH_MS = 60_000;

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** One effective-cap number for the whole fleet. Cached for REFRESH_MS with a
 *  single-flight refresh, and ratcheted per UTC day: the cap may grow intraday
 *  as subs arrive, but a mid-day drop (cancellations) holds until the day
 *  boundary — the guild_usage counter resets on the same UTC day, so the cap
 *  never shrinks below spend already committed. The ratchet is persisted to
 *  fleet_cap_state: a mid-day restart on a day the cap shrank must not
 *  re-anchor below the morning's committed spend (that froze the fleet until
 *  midnight when the store was in-memory). Persistence failures degrade to
 *  the in-memory ratchet — never below it.
 *  getEffective never throws — a failure falls back to the base cap. */
export function createFleetCap(opts: {
  store: FleetStore;
  cfg: FleetCapConfig;
  now?: () => number;
}): {
  getEffective: () => Promise<number>;
  /** Last computed effective cap (base before the first refresh) — for sync
   *  consumers like extractDeps that can't await. */
  current: () => number;
  describe: () => Promise<FleetCapBreakdown>;
} {
  const { store, cfg } = opts;
  const now = opts.now ?? Date.now;
  const base = Math.floor(cfg.baseDailyCap);
  let cache: { at: number; breakdown: FleetCapBreakdown } | null = null;
  let inflight: Promise<FleetCapBreakdown> | null = null;
  let highWater: { day: string; cap: number } | null = null;

  async function compute(): Promise<FleetCapBreakdown> {
    let premiumCount = 0;
    try {
      premiumCount = await store.premiumAccountCount();
    } catch (error) {
      inc("fleet.cap_recompute_error");
      logError("fleet cap premium count failed", error);
    }
    const bonus = computeFleetBonus(premiumCount, cfg);
    const computed = base <= 0 ? base : base + bonus;
    const day = utcDay(now());
    if (!highWater || highWater.day !== day) {
      // Process start or UTC day flip — seed from durable state. A restart
      // mid-day restores the morning's ratcheted cap instead of re-anchoring
      // at the current (possibly lower) computed value.
      const persisted = store.fleetCapHighWater
        ? await store.fleetCapHighWater(day).catch(error => {
            inc("fleet.cap_state_error");
            logError("fleet cap high-water read failed — seeding ratchet empty", error);
            return null;
          })
        : null;
      highWater = { day, cap: persisted ?? 0 };
    }
    if (computed > highWater.cap) {
      highWater.cap = computed;
      await store.setFleetCapHighWater?.(day, computed).catch(error => {
        inc("fleet.cap_state_error");
        logError("fleet cap high-water persist failed — ratchet is in-memory until next restart", error);
      });
    }
    const effective = Math.max(computed, highWater.cap);
    const usedToday = await store.hostedUsageToday().catch(() => 0);
    return { base, bonus, computed, effective, premiumCount, usedToday, maxBonus: Math.floor(cfg.maxBonusCalls) };
  }

  async function refresh(): Promise<FleetCapBreakdown> {
    if (cache && now() - cache.at < REFRESH_MS) return cache.breakdown;
    inflight ??= compute().then(breakdown => {
      if (cache && breakdown.effective !== cache.breakdown.effective) inc("fleet.cap_adjusted");
      cache = { at: now(), breakdown };
      inflight = null;
      return breakdown;
    }, error => {
      inflight = null;
      throw error;
    });
    return inflight;
  }

  return {
    getEffective: async () => {
      try {
        return (await refresh()).effective;
      } catch (error) {
        inc("fleet.cap_recompute_error");
        logError("fleet cap refresh failed — using base cap", error);
        return cache?.breakdown.effective ?? base;
      }
    },
    current: () => {
      // Sync consumers (extractDeps) can't await — but a read that never
      // triggers a refresh would pin a stale value for the process's life,
      // so a stale read kicks a background refresh for the next caller.
      if (!cache || now() - cache.at >= REFRESH_MS) {
        void refresh().catch(error => {
          inc("fleet.cap_recompute_error");
          logError("fleet cap lazy refresh failed", error);
        });
      }
      return cache?.breakdown.effective ?? base;
    },
    describe: async () => {
      try {
        return await refresh();
      } catch (error) {
        inc("fleet.cap_recompute_error");
        logError("fleet cap describe failed", error);
        return cache?.breakdown ?? { base, bonus: 0, computed: base, effective: base, premiumCount: 0, usedToday: 0, maxBonus: Math.floor(cfg.maxBonusCalls) };
      }
    },
  };
}
