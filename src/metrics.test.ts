import assert from "node:assert/strict";
import test from "node:test";
import { inc, drainMetrics, metricsSnapshot } from "./metrics.js";

// drainMetrics rolls per-name deltas into metrics_daily — it must return only
// what accrued since the last drain while metricsSnapshot stays cumulative.

test("drainMetrics returns deltas since the last drain", () => {
  inc("metrics_test.alpha", 3);
  const first = drainMetrics();
  assert.equal(first["metrics_test.alpha"], 3);

  inc("metrics_test.alpha", 2);
  inc("metrics_test.beta");
  const second = drainMetrics();
  assert.equal(second["metrics_test.alpha"], 2, "only the new increments drain");
  assert.equal(second["metrics_test.beta"], 1);

  const third = drainMetrics();
  assert.ok(!("metrics_test.alpha" in third), "nothing new → nothing drained");
  assert.ok(!("metrics_test.beta" in third));
});

test("metricsSnapshot stays cumulative regardless of drains", () => {
  inc("metrics_test.gamma", 5);
  drainMetrics();
  const snap = metricsSnapshot();
  assert.ok(snap.counts["metrics_test.gamma"] >= 5, "snapshot reads the live cumulative counter");
  assert.ok(snap.uptimeSec >= 0);
});
