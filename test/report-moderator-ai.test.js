import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateReportWithAI, reportAiConfig } from "../lib/report-moderator-ai.js";

test("evaluateReportWithAI evaluates text-only report and returns structured verdict", async () => {
  const report = {
    id: "rep_test_1",
    type: "🌊 Flood",
    text: "Water level rose 3 feet across the street during heavy rain.",
    lng: -88.1,
    lat: 15.5
  };

  const mockResponse = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            verdict: "plausible",
            confidence: 85,
            reason: "Reported flooding matches typical heavy rain impacts."
          })
        }
      }
    ]
  };

  const config = reportAiConfig({ AI_API_KEY: "test-groq-key" });
  const result = await evaluateReportWithAI(report, {
    config,
    request: async (url, options) => {
      assert.equal(String(url), "https://api.groq.com/openai/v1/chat/completions");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "openai/gpt-oss-20b");
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.ok(typeof body.messages[1].content === "string");
      assert.doesNotMatch(body.messages[1].content, /Severity:/);
      assert.match(body.messages[1].content, /"nsfw"/);
      return { ok: true, json: async () => mockResponse };
    }
  });

  assert.equal(result.verdict, "plausible");
  assert.equal(result.confidence, 85);
  assert.ok(result.reason.includes("heavy rain"));
});

test("evaluateReportWithAI accepts NSFW as a safety-first verdict", async () => {
  const config = reportAiConfig({ REPORT_AI_API_KEY: "test-key" });
  const result = await evaluateReportWithAI({ type: "Other", text: "Uploaded media", lat: 15, lng: -88 }, {
    config,
    request: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"nsfw","confidence":96,"reason":"A sampled frame contains explicit nudity."}' } }] }) })
  });
  assert.deepEqual(result, { verdict: "nsfw", confidence: 96, reason: "A sampled frame contains explicit nudity." });
});

test("evaluateReportWithAI uses vision model when images are present", async () => {
  const report = {
    id: "rep_test_vision",
    type: "🔥 Fire",
    text: "Smoke coming from the ridge.",
    lng: -88.2,
    lat: 15.6,
    images: [{ url: "data:image/jpeg;base64,/9j/2Q==" }]
  };

  const mockResponse = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            verdict: "suspicious",
            confidence: 65,
            reason: "Coordinates are inconsistent with local topography; the image shows smoke but no clear flame."
          })
        }
      }
    ]
  };

  const config = reportAiConfig({
    REPORT_AI_API_KEY: "test-vision-key",
    REPORT_AI_VISION_MODEL: "vision-test-model"
  });

  const result = await evaluateReportWithAI(report, {
    config,
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, "vision-test-model");
      return { ok: true, json: async () => mockResponse };
    }
  });

  assert.equal(result.verdict, "suspicious");
  assert.equal(result.confidence, 65);
  assert.match(result.reason, /image shows smoke/);
  assert.deepEqual(Object.keys(result).sort(), ["confidence", "reason", "verdict"]);
});

test("evaluateReportWithAI stores video but does not send it to the vision model", async () => {
  const config = reportAiConfig({ REPORT_AI_API_KEY: "test-key", REPORT_AI_VISION_MODEL: "vision", REPORT_AI_TEXT_MODEL: "text" });
  await evaluateReportWithAI({
    type: "Flood",
    text: "Water crossing a road.",
    lat: 15,
    lng: -88,
    images: [{ url: "/uploads/report.mp4", type: "video/mp4" }]
  }, {
    config,
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, "text");
      assert.equal(typeof body.messages[1].content, "string");
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"plausible","confidence":70,"reason":"Description and coordinates are plausible."}' } }] }) };
    }
  });
});

test("evaluateReportWithAI returns unverified when API key is missing", async () => {
  const report = { id: "rep_no_key", type: "Other", text: "Something happened" };
  const config = reportAiConfig({ AI_API_KEY: "", GROQ_API_KEY: "" });
  const result = await evaluateReportWithAI(report, { config });

  assert.equal(result.verdict, "unverified");
  assert.equal(result.confidence, 0);
  assert.ok(result.reason.includes("not configured"));
});

test("evaluateReportWithAI can re-check images moved into quarantine", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alertly-ai-quarantine-"));
  const uploadsDir = path.join(root, "uploads");
  const quarantineDir = path.join(root, "quarantine");
  fs.mkdirSync(uploadsDir);
  fs.mkdirSync(quarantineDir);
  fs.writeFileSync(path.join(quarantineDir, "flagged.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  try {
    const config = reportAiConfig({ REPORT_AI_API_KEY: "test-key", REPORT_AI_VISION_MODEL: "vision" });
    await evaluateReportWithAI({
      type: "Other",
      text: "Moderator re-check",
      geometry: { type: "Point", coordinates: [-88, 15] },
      images: [{ url: "/api/moderation/media/flagged.jpg", type: "image" }]
    }, {
      config,
      uploadsDir: [uploadsDir, quarantineDir],
      request: async (_url, options) => {
        const body = JSON.parse(options.body);
        const imageUrl = body.messages[1].content.find(part => part.type === "image_url").image_url.url;
        assert.match(imageUrl, /^data:image\/jpeg;base64,\/9j\/2Q==$/);
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"plausible","confidence":80,"reason":"The re-checked image is safe."}' } }] }) };
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
