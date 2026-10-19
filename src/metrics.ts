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

/** Per-name increments since the last successful drain, written via `write`
 *  (which upserts them into metrics_daily). The flushed baseline advances by
 *  exactly what was written AFTER the write resolves — a failed write leaves
 *  the deltas intact so the next drain retries them instead of dropping them.
 *  Increments landing between drain and commit ride the next flush.
 *  Single-flight: a second drain started while one is in flight would read the
 *  same pre-commit baseline — writing the deltas twice AND advancing flushed
 *  past the true count (suppressing later increments until counts catch up). */
let draining = false;
export async function drainMetrics(write: (deltas: Record<string, number>) => Promise<void>): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const deltas: Record<string, number> = {};
    for (const [name, count] of counters) {
      const delta = count - (flushed.get(name) ?? 0);
      if (delta > 0) deltas[name] = delta;
    }
    if (!Object.keys(deltas).length) return;
    await write(deltas);
    for (const [name, delta] of Object.entries(deltas)) {
      flushed.set(name, (flushed.get(name) ?? 0) + delta);
    }
  } finally {
    draining = false;
  }
}
