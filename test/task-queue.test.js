import test from "node:test";
import assert from "node:assert/strict";
import { createTaskQueue } from "../lib/task-queue.js";

test("task queue enforces one shared concurrency limit", async () => {
  const queue = createTaskQueue({ concurrency: 2 });
  let running = 0;
  let peak = 0;
  const jobs = Array.from({ length: 8 }, (_, index) => queue.add(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return index;
  }));
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 2);
  assert.deepEqual(queue.status(), { concurrency: 2, active: 0, queued: 0, completed: 8, failed: 0 });
});
