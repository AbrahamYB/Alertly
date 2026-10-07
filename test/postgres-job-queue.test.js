import test from "node:test";
import assert from "node:assert/strict";
import { estimateQueueWaitSeconds } from "../lib/postgres-job-queue.js";

test("durable queue estimate accounts for queued and active work", () => {
  assert.equal(estimateQueueWaitSeconds({ queued: 0, active: 0, concurrency: 1, averageJobSeconds: 120 }), 120);
  assert.equal(estimateQueueWaitSeconds({ queued: 3, active: 1, concurrency: 1, averageJobSeconds: 120 }), 600);
  assert.equal(estimateQueueWaitSeconds({ queued: 3, active: 1, concurrency: 2, averageJobSeconds: 120 }), 360);
});

test("durable queue estimate always provides a useful minimum", () => {
  assert.equal(estimateQueueWaitSeconds({ averageJobSeconds: 0 }), 120);
  assert.equal(estimateQueueWaitSeconds({ averageJobSeconds: 5 }), 30);
});

