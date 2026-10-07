import test from "node:test";
import assert from "node:assert/strict";
import {
  createRateLimiter,
  createDailyQuotaTracker,
  isValidCoordinate,
  sanitizeText,
  getSafeExtension,
} from "../lib/security.js";

test("isValidCoordinate correctly validates latitude and longitude", () => {
  assert.equal(isValidCoordinate(45, -93), true);
  assert.equal(isValidCoordinate(0, 0), true);
  assert.equal(isValidCoordinate(-90, -180), true);
  assert.equal(isValidCoordinate(90, 180), true);

  // Out of bounds
  assert.equal(isValidCoordinate(91, 0), false);
  assert.equal(isValidCoordinate(-91, 0), false);
  assert.equal(isValidCoordinate(0, 181), false);
  assert.equal(isValidCoordinate(0, -181), false);

  // Non-finite / Invalid
  assert.equal(isValidCoordinate(NaN, 0), false);
  assert.equal(isValidCoordinate(undefined, 0), false);
  assert.equal(isValidCoordinate("abc", "def"), false);
});

test("sanitizeText trims and enforces maximum length", () => {
  assert.equal(sanitizeText("   hello world   "), "hello world");
  assert.equal(sanitizeText("abcde", 3), "abc");
  assert.equal(sanitizeText(null), "");
  assert.equal(sanitizeText(undefined), "");
  assert.equal(sanitizeText(12345), "");
});

test("getSafeExtension whitelists safe media extensions and rejects dangerous types", () => {
  assert.equal(getSafeExtension("photo.jpg", "image/jpeg"), ".jpg");
  assert.equal(getSafeExtension("photo.jpeg", "image/jpeg"), ".jpg");
  assert.equal(getSafeExtension("graphic.png", "image/png"), ".png");
  assert.equal(getSafeExtension("animation.webp", "image/webp"), ".webp");
  assert.equal(getSafeExtension("clip.mp4", "video/mp4"), ".mp4");
  assert.equal(getSafeExtension("recording.webm", "video/webm"), ".webm");

  // Dangerous / unsupported extensions must be rejected (null)
  assert.equal(getSafeExtension("malicious.exe", "application/x-msdownload"), null);
  assert.equal(getSafeExtension("script.js", "application/javascript"), null);
  assert.equal(getSafeExtension("shell.sh", "application/x-sh"), null);
  assert.equal(getSafeExtension("vector.svg", "image/svg+xml"), null);
  assert.equal(getSafeExtension("index.html", "text/html"), null);
});

test("createDailyQuotaTracker enforces 15 prompts daily limit", () => {
  const tracker = createDailyQuotaTracker(15);
  const mockReq = {
    cookies: { alertly_sid: "test-session-12345" },
    socket: { remoteAddress: "127.0.0.1" },
  };

  // Initial check
  const initial = tracker.check(mockReq);
  assert.equal(initial.allowed, true);
  assert.equal(initial.used, 0);
  assert.equal(initial.remaining, 15);
  assert.equal(initial.limit, 15);

  // Increment 15 times
  for (let i = 1; i <= 15; i++) {
    const res = tracker.increment(mockReq);
    assert.equal(res.used, i);
    assert.equal(res.remaining, 15 - i);
  }

  // 16th check should be denied
  const blocked = tracker.check(mockReq);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.used, 15);
  assert.equal(blocked.remaining, 0);

  // Reset restores quota
  tracker.reset(mockReq);
  const afterReset = tracker.check(mockReq);
  assert.equal(afterReset.allowed, true);
  assert.equal(afterReset.used, 0);
  assert.equal(afterReset.remaining, 15);
});

test("createRateLimiter throttles excess requests", () => {
  const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2 });
  const mockReq = { ip: "192.168.1.50" };

  let nextCalled = 0;
  let statusCode = 200;
  let jsonOutput = null;

  const mockRes = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      jsonOutput = data;
      return this;
    },
  };

  const next = () => { nextCalled++; };

  // Request 1: allowed
  limiter(mockReq, mockRes, next);
  assert.equal(nextCalled, 1);

  // Request 2: allowed
  limiter(mockReq, mockRes, next);
  assert.equal(nextCalled, 2);

  // Request 3: blocked with 429
  limiter(mockReq, mockRes, next);
  assert.equal(nextCalled, 2); // next NOT called
  assert.equal(statusCode, 429);
  assert.equal(jsonOutput.ok, false);
});

