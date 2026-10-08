import fs from "fs";
import path from "path";
import { extractVideoContactSheets } from "./media-compressor.js";

export function reportAiConfig(env = process.env) {
  const provider = env.REPORT_AI_PROVIDER || env.AI_PROVIDER || "groq";
  return {
    provider,
    baseUrl: (env.REPORT_AI_BASE_URL || env.AI_BASE_URL || (provider === "groq" ? "https://api.groq.com/openai/v1" : "")).replace(/\/$/, ""),
    visionModel: env.REPORT_AI_VISION_MODEL || env.VISION_AI_MODEL || "qwen/qwen3.8-27b",
    textModel: env.REPORT_AI_TEXT_MODEL || env.AI_MODEL || "openai/gpt-oss-20b",
    key: env.REPORT_AI_API_KEY || env.AI_API_KEY || (provider === "groq" ? env.GROQ_API_KEY : "") || "",
  };
}

function imageToBase64DataUri(imagePath, baseDirs) {
  try {
    const filename = path.basename(String(imagePath || ""));
    if (!filename) return null;
    const directories = (Array.isArray(baseDirs) ? baseDirs : [baseDirs]).filter(Boolean);
    const fullPath = directories.map(baseDir => path.join(baseDir, filename)).find(candidate => fs.existsSync(candidate));
    if (!fullPath) return null;

    const ext = path.extname(filename).toLowerCase().replace(/^\./, "");
    const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
    const data = fs.readFileSync(fullPath).toString("base64");
    return `data:${mimeType};base64,${data}`;
  } catch {
    return null;
  }
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v", ".mpeg", ".mpg"]);

function isImageAttachment(image) {
  const url = typeof image === "string" ? image : image?.url;
  const declaredType = typeof image === "object" ? String(image?.type || "").toLowerCase() : "";
  if (!url || declaredType.startsWith("video/")) return false;
  if (declaredType.startsWith("image/")) return true;
  if (String(url).startsWith("data:video/")) return false;
  try {
    return !VIDEO_EXTENSIONS.has(path.extname(new URL(String(url), "http://local").pathname).toLowerCase());
  } catch {
    return !VIDEO_EXTENSIONS.has(path.extname(String(url)).toLowerCase());
  }
}

function isVideoAttachment(media) {
  const url = typeof media === "string" ? media : media?.url;
  const declaredType = typeof media === "object" ? String(media?.type || "").toLowerCase() : "";
  if (declaredType === "video" || declaredType.startsWith("video/")) return true;
  try {
    return VIDEO_EXTENSIONS.has(path.extname(new URL(String(url || ""), "http://local").pathname).toLowerCase());
  } catch {
    return VIDEO_EXTENSIONS.has(path.extname(String(url || "")).toLowerCase());
  }
}

function resolveImageDataUri(image, uploadsDir) {
  const url = typeof image === "string" ? image : image?.url;
  if (!url) return null;
  if (url.startsWith("data:image/") || url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  if (uploadsDir) {
    const fromDisk = imageToBase64DataUri(url, uploadsDir);
    if (fromDisk) return fromDisk;
  }
  return null;
}

export async function evaluateReportWithAI(report, { config = reportAiConfig(), uploadsDir = "", request = fetch, onUsage } = {}) {
  if (!config.key || !config.baseUrl) {
    return {
      verdict: "unverified",
      confidence: 0,
      reason: "AI verification service is not configured with an API key."
    };
  }

  const rawImages = (Array.isArray(report.images) ? report.images : []).filter(isImageAttachment);
  const imageDataUris = rawImages
    .map(img => resolveImageDataUri(img, uploadsDir))
    .filter(Boolean);
  const rawVideos = (Array.isArray(report.images) ? report.images : []).filter(isVideoAttachment);
  const mediaDirs = (Array.isArray(uploadsDir) ? uploadsDir : [uploadsDir]).filter(Boolean);
  // Leave one visual slot available for an uploaded photo when videos are present.
  let remainingImageSlots = Math.min(2, Math.max(0, 3 - imageDataUris.length));
  for (const video of rawVideos) {
    if (!mediaDirs.length || remainingImageSlots <= 0) break;
    const videoUrl = typeof video === "string" ? video : video?.url;
    const filename = path.basename(String(videoUrl || ""));
    const videoPath = mediaDirs.map(directory => path.join(directory, filename)).find(candidate => fs.existsSync(candidate));
    if (!videoPath) continue;
    const sheets = await extractVideoContactSheets(videoPath, { maxSheets: remainingImageSlots });
    imageDataUris.push(...sheets.slice(0, remainingImageSlots));
    remainingImageSlots = Math.min(2, Math.max(0, 3 - imageDataUris.length));
  }

  const hasImages = imageDataUris.length > 0;
  const modelToUse = hasImages ? config.visionModel : config.textModel;

  const promptText = `
You are an emergency management AI verification specialist reviewing a community disaster report.
Analyze the following incident report for authenticity and plausibility:

Incident Category: ${report.type || "Unknown"}
Description: ${report.text || "No description provided"}
Reported Location Coordinates: ${Array.isArray(report.geometry?.coordinates) ? JSON.stringify(report.geometry.coordinates) : `[${report.lng}, ${report.lat}]`}
Attached Visual Inputs: ${imageDataUris.length} (video inputs are chronological 4x4 contact sheets)

Evaluate if this report is:
1. "nsfw": Any image or sampled video frame contains nudity, sexual content, or explicit sexual material. This safety verdict takes priority over every other verdict.
2. "plausible": Credible, consistent with real disaster events, and attached visuals show genuine matching conditions.
3. "suspicious": Contains contradictions, dubious claims, unlikely coordinates, or questionable details.
4. "likely_false": Clear spam, prank, unrelated media, or completely contradictory visuals.

Return ONLY a valid JSON object in this exact schema with no markdown formatting or markdown codeblocks. The reason must include a short description of visible evidence when an image was supplied:
{
  "verdict": "nsfw" | "plausible" | "suspicious" | "likely_false",
  "confidence": <number between 0 and 100>,
  "reason": "<clear explanation in 1-2 sentences, including short visual evidence when present>"
}
`.trim();

  let userContent;
  if (hasImages) {
    userContent = [
      { type: "text", text: promptText },
      ...imageDataUris.slice(0, 3).map(dataUri => ({
        type: "image_url",
        image_url: { url: dataUri }
      }))
    ];
  } else {
    userContent = promptText;
  }

  const endpoint = `${config.baseUrl}/chat/completions`;
  const body = {
    model: modelToUse,
    messages: [
      {
        role: "system",
        content: "You are a professional emergency dispatch verification AI. Output only valid JSON without markdown wrapping."
      },
      {
        role: "user",
        content: userContent
      }
    ],
    temperature: 0.1,
    max_completion_tokens: 500,
    response_format: { type: "json_object" }
  };
  if (config.provider === "groq") body.reasoning_effort = "low";

  try {
    const response = await request(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.key}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.warn(`[REPORT-AI] Vision/Text evaluation failed (HTTP ${response.status}): ${errText.slice(0, 120)}`);
      return {
        verdict: "unverified",
        confidence: 0,
        reason: `AI provider error (HTTP ${response.status}).`
      };
    }

    const data = await response.json();
    onUsage?.({
      category: hasImages ? "report-vision" : "report-text",
      model: modelToUse,
      usage: data.usage || {},
      usedSearch: false,
      rateLimits: {
        requestLimit: response.headers?.get?.("x-ratelimit-limit-requests") || null,
        requestsRemaining: response.headers?.get?.("x-ratelimit-remaining-requests") || null,
        requestsReset: response.headers?.get?.("x-ratelimit-reset-requests") || null,
        tokenLimit: response.headers?.get?.("x-ratelimit-limit-tokens") || null,
        tokensRemaining: response.headers?.get?.("x-ratelimit-remaining-tokens") || null,
        tokensReset: response.headers?.get?.("x-ratelimit-reset-tokens") || null,
      },
    });
    const rawContent = data.choices?.[0]?.message?.content || "";
    const cleaned = rawContent.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const validVerdicts = new Set(["nsfw", "plausible", "suspicious", "likely_false"]);
    const verdict = validVerdicts.has(String(parsed.verdict).toLowerCase()) ? String(parsed.verdict).toLowerCase() : "suspicious";

    return {
      verdict,
      confidence: Math.min(100, Math.max(0, Number(parsed.confidence) || 75)),
      reason: String(parsed.reason || "Evaluated by AI moderation engine.").slice(0, 500)
    };
  } catch (err) {
    console.warn(`[REPORT-AI] Evaluation exception: ${err.message}`);
    return {
      verdict: "unverified",
      confidence: 0,
      reason: "Could not complete automated AI analysis."
    };
  }
}
