import crypto from "crypto";

/**
 * In-memory sliding-window rate limiter for Express.
 * @param {Object} options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.maxRequests - Max requests allowed per window
 * @param {string} [options.message] - Custom error message
 */
export function createRateLimiter({ windowMs = 60000, maxRequests = 30, message = "Too many requests. Please slow down." } = {}) {
  const hits = new Map(); // ip -> [timestamps]

  // Periodic cleanup
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, timestamps] of hits.entries()) {
      const valid = timestamps.filter((t) => t > cutoff);
      if (valid.length === 0) hits.delete(ip);
      else hits.set(ip, valid);
    }
  }, Math.max(10000, windowMs)).unref();

  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const cutoff = now - windowMs;

    const timestamps = (hits.get(ip) || []).filter((t) => t > cutoff);
    if (timestamps.length >= maxRequests) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({
        ok: false,
        error: message,
        retryAfterSec: Math.ceil(windowMs / 1000),
      });
    }

    timestamps.push(now);
    hits.set(ip, timestamps);
    next();
  };
}

/**
 * Tracks and enforces a daily quota per user session or IP (resets at 00:00 UTC).
 * @param {number} maxDaily - Max prompts allowed per day (default 15)
 */
export function createDailyQuotaTracker(maxDaily = 15) {
  const quotas = new Map(); // key -> { day: string, count: number }

  function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function getIdentifier(req) {
    return req.cookies?.alertly_sid || req.ip || req.socket?.remoteAddress || "anonymous";
  }

  return {
    check(req) {
      const id = getIdentifier(req);
      const today = getTodayKey();
      const record = quotas.get(id);

      if (!record || record.day !== today) {
        return { allowed: true, used: 0, remaining: maxDaily, limit: maxDaily };
      }

      const used = record.count;
      const remaining = Math.max(0, maxDaily - used);
      return {
        allowed: used < maxDaily,
        used,
        remaining,
        limit: maxDaily,
      };
    },

    increment(req) {
      const id = getIdentifier(req);
      const today = getTodayKey();
      let record = quotas.get(id);

      if (!record || record.day !== today) {
        record = { day: today, count: 0 };
      }

      record.count += 1;
      quotas.set(id, record);

      return {
        used: record.count,
        remaining: Math.max(0, maxDaily - record.count),
        limit: maxDaily,
      };
    },

    reset(req) {
      const id = getIdentifier(req);
      quotas.delete(id);
    },
  };
}

/**
 * Validates geographic coordinates are within legitimate bounds.
 */
export function isValidCoordinate(lat, lng) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  return Number.isFinite(nLat) && Number.isFinite(nLng)
    && nLat >= -90 && nLat <= 90
    && nLng >= -180 && nLng <= 180;
}

/**
 * Sanitize and bound user string inputs.
 */
export function sanitizeText(str, maxLength = 2000) {
  if (typeof str !== "string") return "";
  return str.trim().slice(0, maxLength);
}

/**
 * Safe file extension detection and mapping for uploaded media.
 */
const ALLOWED_MIME_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "video/avi": ".avi",
  "video/msvideo": ".avi",
  "video/x-flv": ".flv",
  "video/x-ms-wmv": ".wmv",
  "video/3gpp": ".3gp",
  "video/mp2t": ".ts",
  "video/ogg": ".ogv",
  "video/mpeg": ".mpg",
  "video/x-m4v": ".m4v",
};

export function getSafeExtension(originalFilename, mimetype) {
  const extFromMime = ALLOWED_MIME_EXTENSIONS[String(mimetype).toLowerCase()];
  if (extFromMime) return extFromMime;

  const rawExt = (originalFilename.split(".").pop() || "").toLowerCase();
  const allowedExts = new Set([
    "jpg", "jpeg", "png", "webp", "gif",
    "mp4", "webm", "mov", "mkv", "avi", "flv", "wmv", "3gp", "ts", "ogv", "m4v", "mpg", "mpeg"
  ]);
  if (allowedExts.has(rawExt)) {
    return rawExt === "jpeg" ? ".jpg" : `.${rawExt}`;
  }
  return null;
}

