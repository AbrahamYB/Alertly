import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAiUsageTracker } from "../lib/ai-usage.js";

test("AI usage tracking stores aggregates without message content or user identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alertly-ai-usage-"));
  const file = path.join(directory, "usage.json");
  const tracker = createAiUsageTracker(file);
  tracker.record({
    category: "chat",
    model: "test-model",
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    usedSearch: true,
    rateLimits: { requestsRemaining: "999" },
  });

  const result = tracker.summary();
  assert.equal(result.today.requests, 1);
  assert.equal(result.today.totalTokens, 150);
  assert.equal(result.today.averageTokensPerRequest, 150);
  assert.equal(result.today.searchRequests, 1);
  assert.equal(result.latestRateLimits.requestsRemaining, "999");
  const stored = fs.readFileSync(file, "utf8");
  assert.equal(stored.includes("prompt"), true);
  assert.equal(stored.includes("message"), false);
  assert.equal(stored.includes("user"), false);
});
