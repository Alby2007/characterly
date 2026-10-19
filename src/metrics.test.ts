import assert from "node:assert/strict";
import test from "node:test";
import { inc, drainMetrics, metricsSnapshot } from "./metrics.js";

// drainMetrics rolls per-name deltas into metrics_daily — it must write only
// what accrued since the last drain while metricsSnapshot stays cumulative.

const collect = () => {
  const writes: Record<string, number>[] = [];
  return { writes, write: async (d: Record<string, number>) => { writes.push(d); } };
};

test("drainMetrics writes deltas since the last drain", async () => {
  const { writes, write } = collect();
  inc("metrics_test.alpha", 3);
  await drainMetrics(write);
  assert.equal(writes[0]["metrics_test.alpha"], 3);

  inc("metrics_test.alpha", 2);
  inc("metrics_test.beta");
  await drainMetrics(write);
  assert.equal(writes[1]["metrics_test.alpha"], 2, "only the new increments drain");
  assert.equal(writes[1]["metrics_test.beta"], 1);
});

test("a failed write leaves the deltas pending — the next drain retries them", async () => {
  inc("metrics_test.gamma", 4);
  await assert.rejects(drainMetrics(async () => { throw new Error("db down"); }));

  const { writes, write } = collect();
  await drainMetrics(write);
  assert.equal(writes.length, 1, "one retry write");
  assert.equal(writes[0]["metrics_test.gamma"], 4, "the lost interval is not dropped");
});

test("increments between drain and commit are not swallowed by the baseline", async () => {
  inc("metrics_test.delta", 5);
  const { writes } = collect();
  await drainMetrics(async d => {
    inc("metrics_test.delta", 2); // lands while the write is in flight
    writes.push(d);
  });
  assert.equal(writes[0]["metrics_test.delta"], 5);

  const { writes: second, write } = collect();
  await drainMetrics(write);
  assert.equal(second[0]?.["metrics_test.delta"], 2, "the mid-flight increments drain next round");
});

test("metricsSnapshot stays cumulative regardless of drains", async () => {
  inc("metrics_test.epsilon", 5);
  await drainMetrics(async () => {});
  const snap = metricsSnapshot();
  assert.ok(snap.counts["metrics_test.epsilon"] >= 5, "snapshot reads the live cumulative counter");
  assert.ok(snap.uptimeSec >= 0);
});
