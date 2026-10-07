import fs from "fs";
import path from "path";
import { replaceFileSync } from "./file-utils.js";

const RETENTION_DAYS = 90;

function emptyMetric() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, searchRequests: 0 };
}

function addMetric(target, source) {
  for (const key of Object.keys(emptyMetric())) target[key] = Number(target[key] || 0) + Number(source[key] || 0);
  return target;
}

export function createAiUsageTracker(file) {
  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed && parsed.version === 1 && parsed.days ? parsed : { version: 1, days: {} };
    } catch {
      return { version: 1, days: {} };
    }
  }

  function write(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    replaceFileSync(temp, file);
  }

  function record({ category = "chat", model = "unknown", usage = {}, usedSearch = false, rateLimits = {} } = {}) {
    const state = read();
    const day = new Date().toISOString().slice(0, 10);
    const metric = {
      requests: 1,
      promptTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
      completionTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
      totalTokens: Number(usage.total_tokens || 0),
      cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens || usage.cached_tokens || 0),
      searchRequests: usedSearch ? 1 : 0,
    };
    if (!metric.totalTokens) metric.totalTokens = metric.promptTokens + metric.completionTokens;

    state.days[day] ||= { categories: {}, models: {} };
    state.days[day].categories[category] ||= emptyMetric();
    state.days[day].models[model] ||= emptyMetric();
    addMetric(state.days[day].categories[category], metric);
    addMetric(state.days[day].models[model], metric);
    state.days[day].rateLimits = rateLimits;
    state.updatedAt = new Date().toISOString();

    const retained = Object.keys(state.days).sort().slice(-RETENTION_DAYS);
    state.days = Object.fromEntries(retained.map((key) => [key, state.days[key]]));
    write(state);
  }

  function summary() {
    const state = read();
    const dates = Object.keys(state.days).sort();
    const summarize = (selected) => {
      const total = emptyMetric();
      for (const day of selected) {
        for (const metric of Object.values(state.days[day]?.categories || {})) addMetric(total, metric);
      }
      return { ...total, averageTokensPerRequest: total.requests ? Math.round(total.totalTokens / total.requests) : 0 };
    };
    const today = new Date().toISOString().slice(0, 10);
    return {
      ok: true,
      privacy: "Aggregate counts only; prompts, replies, users, sessions, and IP addresses are not stored.",
      today: summarize(dates.filter((date) => date === today)),
      last30Days: summarize(dates.slice(-30)),
      retained: summarize(dates),
      latestRateLimits: dates.length ? state.days[dates.at(-1)]?.rateLimits || {} : {},
      days: state.days,
      updatedAt: state.updatedAt || null,
    };
  }

  return { record, summary };
}
