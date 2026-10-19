// In-process operational counters — no DB, reset on restart. Incremented at
// failure/observability points and surfaced to admins via /status so degraded
// behavior (LLM errors, contest misses) is visible without reading logs.
// drainMetrics() rolls deltas into metrics_daily every flush interval, so the
// counters gain durable daily history; a restart loses at most one interval.
const counters = new Map<string, number>();
const flushed = new Map<string, number>();
const startedAt = Date.now();

export function inc(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function metricsSnapshot(): { uptimeSec: number; counts: Record<string, number> } {
  return {
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    counts: Object.fromEntries([...counters].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Per-name increments since the last drain — the writer upserts these into
 *  metrics_daily. Counters stay cumulative for /status; the flushed baseline
 *  tracks what already hit the rollup. */
export function drainMetrics(): Record<string, number> {
  const deltas: Record<string, number> = {};
  for (const [name, count] of counters) {
    const delta = count - (flushed.get(name) ?? 0);
    if (delta > 0) {
      deltas[name] = delta;
      flushed.set(name, count);
    }
  }
  return deltas;
}
