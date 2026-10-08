import express from "express";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";
import { loadEnvFile } from "node:process";
import { answerChat, aiConfig, classifyChatScope } from "./lib/ai.js";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import fs from "fs";
import multer from "multer";
import { applyReportAiEvaluation, groupNearbyPointHazards, isReportPublic, normalizeCollection, normalizeHazard, normalizeReport, reconcileReportVisibility, sanitizeReportForPublic } from "./lib/domain.js";
import { readProviderStatus } from "./lib/provider-status.js";
import { featureInHazardRegion, getHazardBbox } from "./lib/hazard-region.js";
import { evaluateReportWithAI } from "./lib/report-moderator-ai.js";
import {
  createRateLimiter,
  createDailyQuotaTracker,
  sanitizeText,
  getSafeExtension,
} from "./lib/security.js";
import { autoCompressFile } from "./lib/media-compressor.js";
import { createStaffAccess } from "./lib/staff-access.js";
import { createAiUsageTracker } from "./lib/ai-usage.js";
import { createTaskQueue } from "./lib/task-queue.js";
import { replaceFileSync } from "./lib/file-utils.js";
import {
  CHAT_RETENTION_MS,
  MAX_CHAT_TURNS,
  OUT_OF_SCOPE_REPLY,
  buildChatSystemPrompt,
  localChatResponse,
  normalizeClientChatHistory,
  recentChatContext,
} from "./lib/chat-policy.js";

import { startAutomation, stopAutomation } from "./worker_manager.js";

try { loadEnvFile(new URL(".env", import.meta.url)); } catch (error) { if (error.code !== "ENOENT") throw error; }

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", process.env.TRUST_PROXY || "loopback");
app.disable("x-powered-by");

// Compress regular responses but leave streams and no-transform responses alone.
app.use(compression({
  filter: (req, res) => {
    if (req.headers["x-no-compression"]) return false;
    const cacheControl = res.getHeader("Cache-Control") || "";
    const contentType = res.getHeader("Content-Type") || "";
    if (String(cacheControl).includes("no-transform") || String(contentType).includes("event-stream")) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// Security headers and browser isolation. External origins are restricted to
// the map, font, and sanitization libraries used by the current UI.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), geolocation=(self), microphone=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://unpkg.com https://*.tile.openstreetmap.org https://server.arcgisonline.com",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; "));
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (req.path === "/staff" || req.path.startsWith("/staff/") || req.path.startsWith("/api/staff/") || req.path === "/hazard-admin" || req.path === "/moderation") {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});

const BUNDLED_HAZARDS_FILE = path.join(__dirname, "hazards.geojson");
const HAZARDS_FILE = process.env.HAZARDS_FILE ? path.resolve(process.env.HAZARDS_FILE) : BUNDLED_HAZARDS_FILE;
const HAZARD_METADATA_FILE = HAZARDS_FILE;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const QUARANTINE_DIR = path.join(DATA_DIR, "quarantine");
const UPLOADS_DIR = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.join(__dirname, "uploads");
const BACKUPS_DIR = process.env.BACKUPS_DIR ? path.resolve(process.env.BACKUPS_DIR) : path.join(__dirname, "backups");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const STAFF_ACCESS_FILE = path.join(DATA_DIR, "staff-access.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit.jsonl");
const AI_USAGE_FILE = path.join(DATA_DIR, "ai-usage.json");
const ALERTLY_PUBLIC_URL = String(process.env.ALERTLY_PUBLIC_URL || "https://alertly.live").replace(/\/+$/, "");
const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const AUTOMATED_HAZARD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HAZARD_BBOX = getHazardBbox();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
fs.mkdirSync(path.dirname(HAZARDS_FILE), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });
if (!fs.existsSync(REPORTS_FILE)) fs.writeFileSync(REPORTS_FILE, "[]\n");

const staffAccess = createStaffAccess({ stateFile: STAFF_ACCESS_FILE, auditFile: AUDIT_FILE });
const aiUsage = createAiUsageTracker(AI_USAGE_FILE);
const mediaQueue = createTaskQueue({ concurrency: process.env.MEDIA_PROCESS_CONCURRENCY || 1 });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safeExt = getSafeExtension(file.originalname, file.mimetype) || ".bin";
      cb(null, `${crypto.randomUUID()}${safeExt}`);
    },
  }),
  limits: { files: 5, fileSize: 50 * 1024 * 1024 }, // 50MB upload cap, auto-compressed to <= 2MB 720p
  fileFilter: (_req, file, cb) => {
    const ext = getSafeExtension(file.originalname, file.mimetype);
    if (!ext) {
      return cb(new Error("Unsupported file format. Please upload JPG, PNG, WebP, GIF, MP4, WebM, or MOV."));
    }
    cb(null, true);
  },
});

app.use("/uploads", express.static(UPLOADS_DIR, {
  dotfiles: "deny",
  index: false,
  maxAge: "1d",
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=3600");
  }
}));
// Create the hazard collection on first start.
if (!fs.existsSync(HAZARDS_FILE) && HAZARDS_FILE !== BUNDLED_HAZARDS_FILE && fs.existsSync(BUNDLED_HAZARDS_FILE)) {
  fs.copyFileSync(BUNDLED_HAZARDS_FILE, HAZARDS_FILE);
}
if (!fs.existsSync(HAZARDS_FILE) || fs.statSync(HAZARDS_FILE).size === 0) {
  console.log("Initializing hazards.geojson...");
  fs.writeFileSync(HAZARDS_FILE, JSON.stringify({
    type: "FeatureCollection",
    features: []
  }, null, 2));
}

let hazardsFileCache = { mtimeMs: -1, data: null };
let reportsFileCache = { mtimeMs: -1, data: null };
let normalizedHazardsCache = { mtimeMs: -1, data: null };
const publicResponseCache = new Map();

function sendCachedJson(req, res, namespace, sourceFile, maxAgeSeconds, createPayload) {
  const mtimeMs = fs.statSync(sourceFile).mtimeMs;
  const cacheKey = `${namespace}:${mtimeMs}:${req.originalUrl}`;
  let cached = publicResponseCache.get(cacheKey);
  if (!cached) {
    const body = JSON.stringify(createPayload());
    const etag = `W/\"${crypto.createHash("sha1").update(cacheKey).digest("base64url").slice(0, 16)}\"`;
    cached = { body, etag };
    if (publicResponseCache.size >= 200) publicResponseCache.clear();
    publicResponseCache.set(cacheKey, cached);
  }
  res.setHeader("Cache-Control", `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 2}`);
  res.setHeader("ETag", cached.etag);
  if (req.headers["if-none-match"] === cached.etag) return res.status(304).end();
  return res.type("application/json").send(cached.body);
}

function getHazards() {
  try {
    const mtimeMs = fs.statSync(HAZARDS_FILE).mtimeMs;
    if (hazardsFileCache.data && hazardsFileCache.mtimeMs === mtimeMs) return hazardsFileCache.data;
    const raw = fs.readFileSync(HAZARDS_FILE, "utf8");
    const data = JSON.parse(raw);
    hazardsFileCache = { mtimeMs, data };
    return data;
  } catch (e) {
    return { type: "FeatureCollection", features: [] };
  }
}

function getNormalizedHazards() {
  try {
    const mtimeMs = fs.statSync(HAZARDS_FILE).mtimeMs;
    if (normalizedHazardsCache.data && normalizedHazardsCache.mtimeMs === mtimeMs) return normalizedHazardsCache.data;
    const data = normalizeCollection(getHazards());
    normalizedHazardsCache = { mtimeMs, data };
    return data;
  } catch {
    return { type: "FeatureCollection", features: [] };
  }
}

function getReports() {
  try {
    const mtimeMs = fs.statSync(REPORTS_FILE).mtimeMs;
    if (reportsFileCache.data && reportsFileCache.mtimeMs === mtimeMs) return reportsFileCache.data;
    const reports = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
    const data = Array.isArray(reports) ? reports : [];
    reportsFileCache = { mtimeMs, data };
    return data;
  } catch {
    return [];
  }
}

function saveReports(reports) {
  const tempFile = `${REPORTS_FILE}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(reports, null, 2)}\n`);
    replaceFileSync(tempFile, REPORTS_FILE);
    reportsFileCache = { mtimeMs: -1, data: null };
    publicResponseCache.clear();
  } catch (err) {
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
    throw err;
  }
}

function reconcileStoredReportVisibility() {
  const reports = getReports();
  let changed = false;
  const reconciled = reports.map((report) => {
    const next = reconcileReportVisibility(report);
    if (next.publiclyVisible !== report.publiclyVisible
      || next.moderationStatus !== report.moderationStatus
      || next.verified !== report.verified) changed = true;
    return next;
  });
  if (changed) saveReports(reconciled);
}

reconcileStoredReportVisibility();

function purgeExpiredReports(now = Date.now()) {
  const reports = getReports();
  const expired = reports.filter((report) => {
    const createdAt = Number(report.createdAt);
    return Number.isFinite(createdAt) && now - createdAt >= REPORT_RETENTION_MS;
  });
  if (!expired.length) return { removedReports: 0, removedUploads: 0 };

  const expiredIds = new Set(expired.map((report) => String(report.id)));
  const remaining = reports.filter((report) => !expiredIds.has(String(report.id)));
  const retainedUploads = new Set(remaining.flatMap((report) => report.images || []).map((image) => {
    const mediaUrl = typeof image === "string" ? image : image?.url;
    return path.basename(String(mediaUrl || ""));
  }));
  let removedUploads = 0;

  for (const image of expired.flatMap((report) => report.images || [])) {
    const url = String(typeof image === "string" ? image : image?.url || "");
    const isQuarantined = url.startsWith("/api/moderation/media/");
    if (!url.startsWith("/uploads/") && !isQuarantined) continue;
    const filename = path.basename(url);
    if (!filename || retainedUploads.has(filename)) continue;
    const mediaDir = isQuarantined ? QUARANTINE_DIR : UPLOADS_DIR;
    const filePath = path.join(mediaDir, filename);
    if (path.dirname(filePath) !== mediaDir) continue;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removedUploads++;
      }
    } catch (error) {
      console.warn(`[REPORTS] Could not remove expired upload ${filename}: ${error.message}`);
    }
  }

  saveReports(remaining);
  console.log(`[REPORTS] Removed ${expired.length} reports older than 30 days and ${removedUploads} unused uploads.`);
  return { removedReports: expired.length, removedUploads };
}

function saveHazards(data) {
  const tempFile = `${HAZARDS_FILE}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
    replaceFileSync(tempFile, HAZARDS_FILE);
    hazardsFileCache = { mtimeMs: -1, data: null };
    normalizedHazardsCache = { mtimeMs: -1, data: null };
    publicResponseCache.clear();
  } catch (e) {
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
    throw e;
  }
}

function purgeExpiredAutomatedHazards(now = Date.now()) {
  const collection = getHazards();
  const features = Array.isArray(collection.features) ? collection.features : [];
  const expired = [];
  const retained = [];
  for (const feature of features) {
    try {
      const normalized = normalizeHazard(feature);
      const properties = normalized.properties;
      const source = String(properties.source || "").toLowerCase();
      const isAutomatic = properties.automated === true
        || !["admin", "manual", "community"].includes(source);
      const lastProviderUpdate = new Date(properties.lastUpdatedAt || properties.detectedAt).getTime();
      if (isAutomatic && Number.isFinite(lastProviderUpdate) && now - lastProviderUpdate >= AUTOMATED_HAZARD_RETENTION_MS) {
        expired.push(feature);
      } else {
        retained.push(feature);
      }
    } catch {
      retained.push(feature);
    }
  }
  if (expired.length) {
    saveHazards({ ...collection, features: retained });
    console.log(`[HAZARDS] Removed ${expired.length} automatically added hazards older than 30 days.`);
  }
  return { removedHazards: expired.length };
}

const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function getStaffIdentity(req) {
  const identity = staffAccess.getSession(String(req.cookies?.alertly_staff_session || ""));
  if (identity?.user) req.staffUser = identity.user;
  return identity;
}

function hasAdminAuthorization(req) {
  return Boolean(getStaffIdentity(req)?.user);
}

function requireAdmin(req, res, next) {
  if (hasAdminAuthorization(req)) {
    req.userRole = req.staffUser.role;
    return next();
  }
  return res.status(401).json({ ok: false, error: "Admin authorization required." });
}

function requireModeratorOrAdmin(req, res, next) {
  const identity = getStaffIdentity(req);
  if (identity?.user) {
    req.userRole = identity.user.role;
    return next();
  }
  return res.status(401).json({ ok: false, error: "Moderator or Admin authorization required." });
}

function requireStaff(req, res, next) {
  const identity = getStaffIdentity(req);
  if (!identity?.user) return res.status(401).json({ ok: false, error: "Staff sign-in required." });
  req.staffUser = identity.user;
  next();
}

function requireOwner(req, res, next) {
  const identity = getStaffIdentity(req);
  if (!identity?.user) return res.status(401).json({ ok: false, error: "Staff sign-in required." });
  if (identity.user.role !== "owner") return res.status(403).json({ ok: false, error: "Owner access required." });
  req.staffUser = identity.user;
  next();
}

function requireStaffPage(returnTo) {
  return (req, res, next) => {
    const identity = getStaffIdentity(req);
    if (!identity?.user) return res.redirect(302, `/staff?returnTo=${encodeURIComponent(returnTo)}`);
    req.staffUser = identity.user;
    next();
  };
}

function staffCookieOptions(req) {
  return { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: AUTH_SESSION_TTL_MS, path: "/" };
}

function isLoopbackRequest(req) {
  const remote = String(req.socket?.remoteAddress || "");
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

const publishLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 5,
  message: "Too many reports submitted. Please wait a minute before publishing again.",
});

const removalLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  message: "Too many removal requests. Please wait a minute.",
});

const chatLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 15,
  message: "Too many chat messages. Please wait a moment.",
});

function chatLimiterUnlessStaff(req, res, next) {
  if (getStaffIdentity(req)?.user) return next();
  return chatLimiter(req, res, next);
}

const staffLoginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  message: "Too many sign-in attempts. Please wait before trying again.",
});

const dailyQuotaTracker = createDailyQuotaTracker(15);

const ASSISTANT_NAME = "Alertly AI";

// Chat sessions are intentionally in memory and reset with the process.
const sessions = new Map(); // sid -> { history: [{role, content}], lastSeen: number }

function normalizeAssistantReply(value) {
  const reply = String(value || "").trim();
  if (reply.length > 320) return reply;
  const repeated = reply.match(/^(.{1,160}?)(?:\s*)\1$/s);
  return repeated ? repeated[1].trim() : reply;
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    if (!s?.lastSeen || now - s.lastSeen > CHAT_RETENTION_MS) sessions.delete(sid);
  }
}, 1000 * 60 * 10).unref();

function getOrCreateSession(req, res) {
  let sid = req.cookies?.alertly_sid;

  if (!sid || typeof sid !== "string" || sid.length < 10) sid = crypto.randomUUID();
  // Refresh the cookie on chat activity so an unfinished conversation survives
  // browser restarts but expires after 72 hours of inactivity.
  res.cookie("alertly_sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: CHAT_RETENTION_MS,
    path: "/",
  });

  if (!sessions.has(sid)) {
    sessions.set(sid, { history: [], lastSeen: Date.now() });
  } else {
    sessions.get(sid).lastSeen = Date.now();
  }

  return { sid, session: sessions.get(sid) };
}

function resetSession(sid) {
  sessions.set(sid, { history: [], lastSeen: Date.now() });
}

app.post("/session/reset", (req, res) => {
  const sid = req.cookies?.alertly_sid;
  if (!sid) return res.json({ ok: true, reset: false });
  resetSession(sid);
  res.json({ ok: true, reset: true });
});


app.get(["/", "/index.html", "/index.html.var"], (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/report", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.sendFile(path.join(__dirname, "report.html"));
});

app.get(["/staff", "/staff/join"], (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.sendFile(path.join(__dirname, "staff.html"));
});

app.get("/moderation", requireStaffPage("/moderation"), (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "moderation.html"));
});

app.get("/hazard-admin", requireStaffPage("/hazard-admin"), (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "hazard-admin.html"));
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "alertly",
    mode: process.env.NODE_ENV || "development",
    automationEnabled: process.env.ENABLE_AUTOMATION === "true",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/auth/status", (req, res) => {
  const identity = getStaffIdentity(req);
  res.json({
    ok: true,
    isAdmin: Boolean(identity?.user),
    isModerator: Boolean(identity?.user),
    authenticated: Boolean(identity?.user),
    user: identity?.user || null,
    authRequired: true,
  });
});

app.post("/api/auth/login", (_req, res) => {
  res.status(410).json({ ok: false, error: "Key-based browser login has been replaced by individual Staff accounts." });
});

app.post("/api/auth/logout", (req, res) => {
  const token = String(req.cookies?.alertly_staff_session || "");
  if (token) staffAccess.signOut(token, staffAccess.contextFromRequest(req));
  res.clearCookie("alertly_staff_session", { path: "/" });
  res.clearCookie("alertly_admin_key", { path: "/" });
  res.json({ ok: true, message: "Logged out." });
});

app.get("/api/staff/session", (req, res) => {
  const identity = getStaffIdentity(req);
  res.json({ ok: true, authenticated: Boolean(identity?.user), user: identity?.user || null });
});

app.post("/api/staff/sign-in", staffLoginLimiter, async (req, res) => {
  const context = staffAccess.contextFromRequest(req);
  const result = await staffAccess.signIn({ email: req.body?.email, password: req.body?.password, context });
  if (!result) return res.status(401).json({ ok: false, error: "Invalid email or password." });
  res.cookie("alertly_staff_session", result.token, staffCookieOptions(req));
  res.json({ ok: true, user: result.user });
});

app.post("/api/staff/sign-out", (req, res) => {
  const token = String(req.cookies?.alertly_staff_session || "");
  if (token) staffAccess.signOut(token, staffAccess.contextFromRequest(req));
  res.clearCookie("alertly_staff_session", { path: "/" });
  res.json({ ok: true });
});

app.post("/api/staff/join", staffLoginLimiter, async (req, res) => {
  try {
    const result = await staffAccess.acceptInvitation({
      token: req.body?.token,
      name: req.body?.name,
      email: req.body?.email,
      password: req.body?.password,
      context: staffAccess.contextFromRequest(req),
    });
    res.cookie("alertly_staff_session", result.token, staffCookieOptions(req));
    res.status(201).json({ ok: true, user: result.user });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/staff/bootstrap-owner", (req, res) => {
  if (!isLoopbackRequest(req)) return res.status(403).json({ ok: false, error: "Owner bootstrap is available only from the server itself." });
  if (staffAccess.hasAnyUsers()) return res.status(409).json({ ok: false, error: "Staff accounts already exist." });
  try {
    const result = staffAccess.createInvitation({ role: "owner", allowBootstrap: true, context: staffAccess.contextFromRequest(req) });
    res.status(201).json({ ok: true, inviteUrl: `${ALERTLY_PUBLIC_URL}/staff/join?token=${encodeURIComponent(result.token)}`, expiresAt: result.invitation.expiresAt });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/staff/accounts", requireOwner, (req, res) => {
  res.json({ ok: true, accounts: staffAccess.listAccounts(), invitations: staffAccess.listInvitations(), transfer: staffAccess.getPendingTransfer(req.staffUser.id) });
});

app.post("/api/staff/invitations", requireOwner, (req, res) => {
  try {
    const result = staffAccess.createInvitation({ actor: req.staffUser, email: req.body?.email, role: "staff", context: staffAccess.contextFromRequest(req) });
    res.status(201).json({ ok: true, inviteUrl: `${ALERTLY_PUBLIC_URL}/staff/join?token=${encodeURIComponent(result.token)}`, invitation: result.invitation });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/staff/invitations/:id/revoke", requireOwner, (req, res) => {
  try {
    staffAccess.revokeInvitation({ id: req.params.id, actor: req.staffUser, context: staffAccess.contextFromRequest(req) });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/staff/accounts/:id/disabled", requireOwner, (req, res) => {
  try {
    const user = staffAccess.setDisabled({ userId: req.params.id, disabled: Boolean(req.body?.disabled), actor: req.staffUser, context: staffAccess.contextFromRequest(req) });
    res.json({ ok: true, user });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/staff/ownership-transfer", requireStaff, (req, res) => {
  res.json({ ok: true, transfer: staffAccess.getPendingTransfer(req.staffUser.id) });
});

app.post("/api/staff/ownership-transfer", requireOwner, async (req, res) => {
  try {
    const transfer = await staffAccess.beginTransfer({ actor: req.staffUser, targetUserId: req.body?.targetUserId, password: req.body?.password, context: staffAccess.contextFromRequest(req) });
    res.status(201).json({ ok: true, transfer });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/staff/ownership-transfer/:id/accept", requireStaff, async (req, res) => {
  try {
    const result = await staffAccess.acceptTransfer({ actor: req.staffUser, transferId: req.params.id, password: req.body?.password, context: staffAccess.contextFromRequest(req) });
    res.clearCookie("alertly_staff_session", { path: "/" });
    res.json({ ok: true, ...result, reauthenticationRequired: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/staff/ownership-transfer/:id/cancel", requireOwner, (req, res) => {
  try {
    staffAccess.cancelTransfer({ actor: req.staffUser, transferId: req.params.id, context: staffAccess.contextFromRequest(req) });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/staff/audit", requireOwner, (req, res) => {
  res.json({ ok: true, events: staffAccess.readAudit(req.query.limit) });
});

app.get("/api/staff/ai-usage", requireStaff, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(aiUsage.summary());
});

app.get("/api/staff/media-queue", requireStaff, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, ...mediaQueue.status() });
});

app.use((req, res, next) => {
  const mutating = ["POST", "PATCH", "DELETE"].includes(req.method);
  const managedPath = req.path.startsWith("/api/admin/")
    || req.path.startsWith("/api/moderation/")
    || req.path === "/hazards/publish";
  if (mutating && managedPath) {
    res.on("finish", () => {
      staffAccess.audit({
        action: "management.change",
        actor: req.staffUser || (req.userRole ? { role: req.userRole } : null),
        target: { id: req.params?.id || null, type: req.path.startsWith("/api/moderation/") ? "community-report" : "official-hazard" },
        outcome: res.statusCode < 400 ? "success" : "failure",
        details: { method: req.method, path: req.path, status: res.statusCode },
        context: staffAccess.contextFromRequest(req),
      });
    });
  }
  next();
});

app.get("/api/chat/quota", (req, res) => {
  if (getStaffIdentity(req)?.user) {
    return res.json({ ok: true, allowed: true, unlimited: true, used: 0, remaining: null, limit: null });
  }
  const quota = dailyQuotaTracker.check(req);
  res.json({ ok: true, ...quota });
});

app.get("/api/provider-status", (_req, res) => {
  res.json(readProviderStatus(HAZARD_METADATA_FILE));
});

app.get("/api/reports/data", (req, res) => {
  return sendCachedJson(req, res, "reports", REPORTS_FILE, 10, () =>
    getReports().filter(isReportPublic).flatMap((report) => {
      try { return [sanitizeReportForPublic(report)]; } catch { return []; }
    })
  );
});

app.get("/api/moderation/reports", requireModeratorOrAdmin, (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  purgeExpiredReports();
  const reports = getReports().flatMap((report) => {
    try { return [normalizeReport(report)]; } catch { return []; }
  });
  res.json(reports.sort((a, b) => Number(b.createdAt) - Number(a.createdAt)));
});

app.get("/api/moderation/media/:filename", requireModeratorOrAdmin, (req, res) => {
  const filename = path.basename(String(req.params.filename || ""));
  const mediaPath = path.join(QUARANTINE_DIR, filename);
  if (!filename || !fs.existsSync(mediaPath)) return res.status(404).json({ success: false, error: "Media not found." });
  res.setHeader("Cache-Control", "private, no-store");
  res.sendFile(mediaPath);
});

function quarantineReportMedia(report) {
  report.images = (Array.isArray(report.images) ? report.images : []).map((media) => {
    const item = typeof media === "string" ? { url: media } : media;
    if (!String(item?.url || "").startsWith("/uploads/")) return item;
    const filename = path.basename(item.url);
    const publicPath = path.join(UPLOADS_DIR, filename);
    const privatePath = path.join(QUARANTINE_DIR, filename);
    if (fs.existsSync(publicPath)) replaceFileSync(publicPath, privatePath);
    return { ...item, url: `/api/moderation/media/${filename}` };
  });
  return report;
}

function restoreQuarantinedMedia(report) {
  report.images = (Array.isArray(report.images) ? report.images : []).map((media) => {
    const item = typeof media === "string" ? { url: media } : media;
    if (!String(item?.url || "").startsWith("/api/moderation/media/")) return item;
    const filename = path.basename(item.url);
    const privatePath = path.join(QUARANTINE_DIR, filename);
    const publicPath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(privatePath)) replaceFileSync(privatePath, publicPath);
    return { ...item, url: `/uploads/${filename}` };
  });
  return report;
}

function cleanupFailedReportMedia(files = [], media = []) {
  const filenames = new Set([
    ...files.map(file => path.basename(String(file?.filename || file?.path || ""))),
    ...media.map(item => path.basename(String(typeof item === "string" ? item : item?.url || ""))),
  ].filter(Boolean));
  for (const filename of filenames) {
    for (const directory of [UPLOADS_DIR, QUARANTINE_DIR]) {
      const target = path.join(directory, filename);
      try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (error) {
        console.warn(`[REPORTS] Could not clean failed upload ${target}: ${error.message}`);
      }
    }
  }
}

app.patch("/api/moderation/reports/:id", requireModeratorOrAdmin, (req, res) => {
  const reports = getReports();
  const index = reports.findIndex((report) => String(report.id) === String(req.params.id));
  if (index < 0) return res.status(404).json({ success: false, error: "Report not found." });

  const allowedStatuses = new Set(["pending", "approved", "rejected"]);
  const allowedIncidentStatuses = new Set(["active", "monitoring", "resolved"]);
  const existing = reports[index];
  const changes = {};

  if (req.body.type !== undefined) changes.type = sanitizeText(req.body.type, 100);
  if (req.body.text !== undefined) changes.text = sanitizeText(req.body.text, 4000);
  if (req.body.severity !== undefined) {
    const value = String(req.body.severity).toLowerCase();
    if (!["unknown", "low", "medium", "high", "critical"].includes(value)) {
      return res.status(400).json({ success: false, error: "Invalid report severity." });
    }
    changes.severity = value;
  }
  if (req.body.moderationStatus !== undefined) {
    const value = String(req.body.moderationStatus).toLowerCase();
    if (!allowedStatuses.has(value)) return res.status(400).json({ success: false, error: "Invalid moderation status." });
    changes.moderationStatus = value;
    changes.verified = value === "approved";
    changes.isRemoved = value === "rejected";
    changes.publiclyVisible = value === "approved";
  }
  if (req.body.status !== undefined) {
    const value = String(req.body.status).toLowerCase();
    if (!allowedIncidentStatuses.has(value)) return res.status(400).json({ success: false, error: "Invalid report status." });
    changes.status = value;
  }
  if (req.body.geometry !== undefined) changes.geometry = req.body.geometry;
  if (req.body.mergedInto !== undefined) {
    const target = reports.find((report) => String(report.id) === String(req.body.mergedInto));
    if (!target || String(target.id) === String(existing.id)) {
      return res.status(400).json({ success: false, error: "Choose another existing report to merge into." });
    }
    changes.mergedInto = String(target.id);
    changes.moderationStatus = "rejected";
    changes.status = "resolved";
    changes.isRemoved = true;
  }

  try {
    const now = new Date().toISOString();
    const action = String(req.body.action || "updated").slice(0, 80);
    const note = sanitizeText(req.body.note || "", 500);
    const candidate = normalizeReport({ ...existing, ...changes, updatedAt: now });
    if (changes.moderationStatus === "approved") restoreQuarantinedMedia(candidate);
    candidate.auditLog = [
      ...(Array.isArray(existing.auditLog) ? existing.auditLog : []),
      { id: crypto.randomUUID(), action, note, at: now, actor: req.userRole || "Moderator" },
    ];
    reports[index] = candidate;
    saveReports(reports);
    res.json({ success: true, report: candidate });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete("/api/moderation/reports/:id", requireModeratorOrAdmin, (req, res) => {
  const reports = getReports();
  const index = reports.findIndex((report) => String(report.id) === String(req.params.id));
  if (index < 0) return res.status(404).json({ success: false, error: "Report not found." });

  const [removed] = reports.splice(index, 1);
  saveReports(reports);

  // Permanently delete public or quarantined media only after a moderator deletes the report.
  if (Array.isArray(removed.images)) {
    for (const img of removed.images) {
      const mediaUrl = typeof img === "string" ? img : img?.url;
      const isPublic = typeof mediaUrl === "string" && mediaUrl.startsWith("/uploads/");
      const isQuarantined = typeof mediaUrl === "string" && mediaUrl.startsWith("/api/moderation/media/");
      if (isPublic || isQuarantined) {
        const filename = path.basename(mediaUrl);
        const filepath = path.join(isQuarantined ? QUARANTINE_DIR : UPLOADS_DIR, filename);
        try {
          if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
        } catch (err) {
          console.error(`[MODERATION] Failed to delete image ${filepath}:`, err);
        }
      }
    }
  }

  res.json({ success: true, removedId: removed.id });
});

app.post("/api/reports/publish", publishLimiter, upload.array("images", 5), async (req, res) => {
  let processedMedia = [];
  try {
    const input = JSON.parse(req.body.reportData || "{}");
    if (input.geometry?.type !== "Polygon") {
      cleanupFailedReportMedia(req.files || []);
      return res.status(400).json({ success: false, error: "New community reports must use GPS Circle or Area geometry." });
    }
    if (input.text) input.text = sanitizeText(input.text, 4000);
    if (input.type) input.type = sanitizeText(input.type, 100);
    if (req.query.validate === "true") {
      cleanupFailedReportMedia(req.files || []);
      return res.json({ success: true, validated: true, report: normalizeReport(input) });
    }
    if (req.files?.length) {
      // One bounded queue is shared across every uploader. This prevents a
      // burst of reports from launching unbounded FFmpeg processes.
      processedMedia = await Promise.all(
        req.files.map((file) => mediaQueue.add(async () => {
          const compResult = await autoCompressFile(file.path, { targetSizeMB: 2, maxResolution: 720 });
          const finalFilename = compResult.finalFilename || file.filename;
          return {
            url: `/uploads/${finalFilename}`,
            name: file.originalname,
            type: compResult.type || (file.mimetype.startsWith("video/") ? "video" : "image"),
            size: compResult.compressedSize || file.size,
            originalSize: compResult.originalSize || file.size,
          };
        }))
      );
      input.images = processedMedia;
    }
    let report = normalizeReport(input);
    // Complete the initial safety review before publishing so explicit media
    // cannot briefly appear in the public feed while a background job runs.
    const aiEvaluation = await evaluateReportWithAI(report, { uploadsDir: UPLOADS_DIR, onUsage: (entry) => aiUsage.record(entry) });
    report = applyReportAiEvaluation(report, aiEvaluation);
    if (aiEvaluation.verdict === "nsfw") {
      quarantineReportMedia(report);
      console.warn(`[REPORT-AI] Quarantined NSFW report ${report.id} before publication.`);
    }
    const reports = getReports();
    reports.push(report);
    saveReports(reports);
    res.status(201).json({ success: true, id: report.id, images: report.images || [], report: sanitizeReportForPublic(report) });
  } catch (error) {
    cleanupFailedReportMedia(req.files || [], processedMedia);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post("/api/moderation/reports/:id/verify-ai", requireModeratorOrAdmin, async (req, res) => {
  const reports = getReports();
  const index = reports.findIndex((report) => String(report.id) === String(req.params.id));
  if (index < 0) return res.status(404).json({ success: false, error: "Report not found." });

  const target = reports[index];
  try {
    const aiEvaluation = await evaluateReportWithAI(target, { uploadsDir: [UPLOADS_DIR, QUARANTINE_DIR], onUsage: (entry) => aiUsage.record(entry) });
    reports[index] = applyReportAiEvaluation(reports[index], aiEvaluation);
    if (aiEvaluation.verdict === "nsfw") quarantineReportMedia(reports[index]);
    else if (aiEvaluation.verdict === "plausible") restoreQuarantinedMedia(reports[index]);
    reports[index].updatedAt = new Date().toISOString();
    saveReports(reports);
    res.json({ success: true, aiEvaluation, report: reports[index] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/moderation/reports/:id/removal-requests/:reqId/resolve", requireModeratorOrAdmin, (req, res) => {
  const reports = getReports();
  const index = reports.findIndex((report) => String(report.id) === String(req.params.id));
  if (index < 0) return res.status(404).json({ success: false, error: "Report not found." });

  const report = reports[index];
  const removalRequests = Array.isArray(report.removalRequests) ? report.removalRequests : [];
  const reqIndex = removalRequests.findIndex((r) => String(r.id) === String(req.params.reqId));
  if (reqIndex < 0) return res.status(404).json({ success: false, error: "Removal request not found." });

  const resolution = String(req.body?.action || "").toLowerCase(); // "accept" or "dismiss"
  if (!["accept", "dismiss"].includes(resolution)) {
    return res.status(400).json({ success: false, error: "Action must be 'accept' or 'dismiss'." });
  }

  const now = new Date().toISOString();
  const note = sanitizeText(req.body?.note || "", 500);

  removalRequests[reqIndex] = {
    ...removalRequests[reqIndex],
    status: resolution === "accept" ? "accepted" : "dismissed",
    resolvedAt: now,
    resolutionNote: note,
  };

  if (resolution === "accept") {
    report.isRemoved = true;
    report.moderationStatus = "rejected";
    report.status = "resolved";
  }

  report.removalRequests = removalRequests;
  report.updatedAt = now;
  report.auditLog = [
    ...(Array.isArray(report.auditLog) ? report.auditLog : []),
    {
      id: crypto.randomUUID(),
      action: `removal-request-${resolution === "accept" ? "accepted" : "dismissed"}`,
      note: note || `Removal request ${removalRequests[reqIndex].id} ${resolution === "accept" ? "accepted" : "dismissed"}`,
      at: now,
      actor: req.userRole || "Moderator",
    },
  ];

  reports[index] = report;
  saveReports(reports);

  res.json({ success: true, report });
});

app.post("/api/removal", removalLimiter, (req, res) => {
  const reportId = String(req.body?.reportData?.id || "");
  const reason = sanitizeText(req.body?.reason || "", 500);
  if (!reportId || !reason) return res.status(400).json({ success: false, error: "A report and reason are required." });
  const reports = getReports();
  const index = reports.findIndex((report) => String(report.id) === reportId);
  if (index < 0) return res.status(404).json({ success: false, error: "Report not found." });
  const now = new Date().toISOString();
  reports[index].removalRequests = [
    ...(Array.isArray(reports[index].removalRequests) ? reports[index].removalRequests : []),
    { id: crypto.randomUUID(), reason, at: now, status: "pending" },
  ];
  reports[index].auditLog = [
    ...(Array.isArray(reports[index].auditLog) ? reports[index].auditLog : []),
    { id: crypto.randomUUID(), action: "removal-requested", note: reason, at: now, actor: "Community" },
  ];
  reports[index].updatedAt = now;
  saveReports(reports);
  res.status(202).json({ success: true, queued: true, message: "Removal request sent to moderators." });
});

app.post("/chat", chatLimiterUnlessStaff, async (req, res) => {
  const message = req.body?.message;
  if (typeof message !== 'string' || !message.trim() || message.length > 12000) return res.status(400).json({ error: 'Enter a message of 1–12,000 characters.' });
  const wantsJson = String(req.headers.accept || '').includes('application/json') || req.body?.responseMode === 'json';

  const staffHasUnlimitedChat = Boolean(getStaffIdentity(req)?.user);
  const quota = staffHasUnlimitedChat
    ? { allowed: true, unlimited: true, used: 0, remaining: null, limit: null }
    : dailyQuotaTracker.check(req);

  const clientHistory = normalizeClientChatHistory(req.body?.history);
  const localReply = localChatResponse(message);
  if (localReply) {
    const payload = {
      reply: localReply,
      scopeRestricted: false,
      handledLocally: true,
      quotaRemaining: quota.remaining,
      quotaUsed: quota.used,
      quotaLimit: quota.limit,
      quotaUnlimited: staffHasUnlimitedChat,
    };
    if (wantsJson) return res.json(payload);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.write('data: ' + JSON.stringify({ chunk: payload.reply, scopeRestricted: payload.scopeRestricted, handledLocally: true }) + '\n\n');
    res.write('data: ' + JSON.stringify({ done: true, quotaRemaining: quota.remaining, quotaUnlimited: staffHasUnlimitedChat }) + '\n\n');
    return res.end();
  }

  if (!staffHasUnlimitedChat && !quota.allowed) {
    return res.status(429).json({
      error: 'Daily limit reached (15 prompts per day). Please return tomorrow.',
      used: quota.used,
      remaining: 0,
      limit: quota.limit,
    });
  }

  const { sid } = getOrCreateSession(req, res);
  if (req.body.reset === true || ['1', 'true'].includes(req.headers['x-alertly-reset'])) resetSession(sid);
  const session = sessions.get(sid);
  const contextHistory = req.body.reset === true || ['1', 'true'].includes(req.headers['x-alertly-reset'])
    ? []
    : (clientHistory.length ? clientHistory : session.history);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  if (wantsJson) {
    res.set({ 'Cache-Control': 'no-store' });
  } else {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  }
  const send = value => { if (!res.destroyed) res.write('data: ' + JSON.stringify(value) + '\n\n'); };
  const heartbeat = wantsJson ? null : setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 5000);
  res.on('close', () => controller.abort());

  try {
    const config = aiConfig();
    const allowedByScope = await classifyChatScope(message, recentChatContext(contextHistory), {
      signal: controller.signal,
      config,
      onUsage: (entry) => aiUsage.record(entry),
    });
    if (!allowedByScope) {
      if (wantsJson) {
        return res.json({
          reply: OUT_OF_SCOPE_REPLY,
          scopeRestricted: true,
          quotaRemaining: quota.remaining,
          quotaUsed: quota.used,
          quotaLimit: quota.limit,
          quotaUnlimited: staffHasUnlimitedChat,
        });
      }
      send({ chunk: OUT_OF_SCOPE_REPLY, scopeRestricted: true });
      send({ done: true, quotaRemaining: quota.remaining, quotaUnlimited: staffHasUnlimitedChat });
      return;
    }
    const quotaAfterIncrement = staffHasUnlimitedChat ? quota : dailyQuotaTracker.increment(req);
    if (!wantsJson) {
      send({
        status: 'Preparing your answer…',
        quotaRemaining: quotaAfterIncrement.remaining,
        quotaUsed: quotaAfterIncrement.used,
        quotaLimit: quotaAfterIncrement.limit,
        quotaUnlimited: staffHasUnlimitedChat,
      });
    }
    const rawReply = await answerChat([
      {
        role: 'system',
        content: buildChatSystemPrompt({ assistantName: ASSISTANT_NAME, model: config.model, date: new Date().toISOString().slice(0,10) })
      },
      ...recentChatContext(contextHistory),
      { role: 'user', content: message.trim() },
    ], { signal: controller.signal, config, onUsage: (entry) => aiUsage.record(entry) });
    const reply = normalizeAssistantReply(rawReply);
    if (!res.destroyed) {
      session.history.push({ role: 'user', content: message.trim() }, { role: 'assistant', content: reply });
      session.history = session.history.slice(-MAX_CHAT_TURNS * 2);
      session.lastSeen = Date.now();
      if (wantsJson) {
        res.json({
          reply,
          quotaRemaining: quotaAfterIncrement.remaining,
          quotaUsed: quotaAfterIncrement.used,
          quotaLimit: quotaAfterIncrement.limit,
          quotaUnlimited: staffHasUnlimitedChat,
        });
      } else {
        send({ chunk: reply });
        send({ done: true, quotaRemaining: quotaAfterIncrement.remaining, quotaUnlimited: staffHasUnlimitedChat });
      }
    }
  } catch (error) {
    const errorMessage = controller.signal.aborted ? 'AI request timed out. Please try again.' : error.message;
    if (wantsJson && !res.headersSent) res.status(controller.signal.aborted ? 504 : 502).json({ error: errorMessage });
    else send({ error: errorMessage });
  } finally {
    clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    if (!wantsJson) res.end();
  }
});

app.get("/hazards/data", (req, res) => {
  return sendCachedJson(req, res, "hazards", HAZARDS_FILE, 20, () => {
    const allHazards = getNormalizedHazards();
    const communityFeatures = getReports().filter(isReportPublic).flatMap((report) => {
      try {
        const normalized = normalizeReport(report);
        return [normalizeHazard({
          type: "Feature",
          id: normalized.id,
          geometry: normalized.geometry,
          properties: {
            hazard: normalized.type,
            title: normalized.text || `${normalized.type} community report`,
            description: normalized.text,
            severity: normalized.severity,
            confidence: normalized.moderationStatus === "approved" ? "confirmed" : "probable",
            status: normalized.status,
            source: "community",
            sourceType: "community report",
            communityReport: true,
            reportId: normalized.id,
            detectedAt: normalized.detectedAt,
            createdAt: normalized.detectedAt,
            lastUpdatedAt: normalized.updatedAt,
          },
        })];
      } catch {
        return [];
      }
    });
    const combinedHazards = { ...allHazards, features: [...allHazards.features, ...communityFeatures] };
    const includeRecent = req.query.view === "recent";
    const requestedBbox = String(req.query.bbox || "").split(",").map(Number);
    const viewportBbox = requestedBbox.length === 4 && requestedBbox.every(Number.isFinite)
      ? requestedBbox
      : HAZARD_BBOX;
    const longitudeSpan = Math.min(360, Math.abs(viewportBbox[2] - viewportBbox[0]));
    const latitudeSpan = Math.min(145, Math.abs(viewportBbox[3] - viewportBbox[1]));
    const middleLatitude = (viewportBbox[1] + viewportBbox[3]) / 2;
    const widthKm = longitudeSpan * 111.32 * Math.max(0.2, Math.cos(middleLatitude * Math.PI / 180));
    const heightKm = latitudeSpan * 111.32;
    const displayRadiusKm = Math.max(10, Math.min(1200, Math.hypot(widthKm, heightKm) / 6));
    const normalized = {
      ...combinedHazards,
      features: combinedHazards.features.filter((feature) =>
      (includeRecent || feature.properties.status === "active") && featureInHazardRegion(feature, viewportBbox)
      )
    };
    const displayed = groupNearbyPointHazards(normalized, displayRadiusKm);
    if (displayRadiusKm > 10) {
      for (const feature of displayed.features) {
        if (!feature.properties?.grouped) continue;
        const count = feature.properties.groupedEventCount;
        const label = String(feature.properties.hazard || "hazard").replace(/(^|-)(\w)/g, (_match, _dash, letter) => ` ${letter.toUpperCase()}`).trim();
        feature.properties.title = `${label} — ${count} reports at this zoom`;
        feature.properties.description = `${count} current ${feature.properties.hazard} reports are combined for map readability. Zoom in to separate them.`;
        feature.properties.displayCluster = true;
      }
    }
    return displayed;
  });
});

app.get("/api/admin/hazards", requireAdmin, (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  purgeExpiredAutomatedHazards();
  res.json(normalizeCollection(getHazards()));
});

app.post("/hazards/publish", requireAdmin, (req, res) => {
  const newFeature = req.body.feature;
  if (!newFeature) return res.status(400).json({ error: "No feature provided" });

  try {
    const hazards = normalizeCollection(getHazards());
    const normalized = normalizeHazard(newFeature);
    hazards.features.push(normalized);
    saveHazards(hazards);

    res.status(201).json({ ok: true, hazard: normalized });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.patch("/api/admin/hazards/:id", requireAdmin, (req, res) => {
  const hazards = normalizeCollection(getHazards());
  const index = hazards.features.findIndex((feature) => String(feature.id) === String(req.params.id));
  if (index < 0) return res.status(404).json({ ok: false, error: "Hazard not found." });
  try {
    const current = hazards.features[index];
    const now = new Date().toISOString();
    const updated = normalizeHazard({
      ...current,
      geometry: req.body.geometry || current.geometry,
      properties: { ...current.properties, ...(req.body.properties || {}), lastUpdatedAt: now },
    });
    updated.properties.auditLog = [
      ...(Array.isArray(current.properties.auditLog) ? current.properties.auditLog : []),
      { id: crypto.randomUUID(), action: String(req.body.action || "updated"), at: now, actor: req.userRole || "Administrator" },
    ];
    hazards.features[index] = updated;
    saveHazards(hazards);
    res.json({ ok: true, hazard: updated });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/admin/hazards/:id/merge", requireAdmin, (req, res) => {
  const hazards = normalizeCollection(getHazards());
  const sourceIndex = hazards.features.findIndex((feature) => String(feature.id) === String(req.params.id));
  const targetIndex = hazards.features.findIndex((feature) => String(feature.id) === String(req.body.targetId));
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return res.status(400).json({ ok: false, error: "Choose two different existing hazards." });
  }
  const source = hazards.features[sourceIndex];
  const target = hazards.features[targetIndex];
  const now = new Date().toISOString();
  target.properties.supportingEvidence = [
    ...(Array.isArray(target.properties.supportingEvidence) ? target.properties.supportingEvidence : []),
    { hazardId: source.id, title: source.properties.title, source: source.properties.source, sourceUrl: source.properties.sourceUrl },
  ];
  target.properties.lastUpdatedAt = now;
  target.properties.auditLog = [
    ...(Array.isArray(target.properties.auditLog) ? target.properties.auditLog : []),
    { id: crypto.randomUUID(), action: `merged ${source.id}`, at: now, actor: req.userRole || "Administrator" },
  ];
  hazards.features.splice(sourceIndex, 1);
  saveHazards(hazards);
  res.json({ ok: true, hazard: target });
});

app.delete("/api/admin/hazards/:id", requireAdmin, (req, res) => {
  const hazards = normalizeCollection(getHazards());
  const index = hazards.features.findIndex((feature) => String(feature.id) === String(req.params.id));
  if (index < 0) return res.status(404).json({ ok: false, error: "Hazard not found." });
  const [removed] = hazards.features.splice(index, 1);
  saveHazards(hazards);
  res.json({ ok: true, removedId: removed.id });
});

// Return client-safe errors without exposing stack traces.
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    cleanupFailedReportMedia(req.files || []);
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ success: false, error: "File too large. Maximum upload size is 50MB." });
    }
    return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
  }
  const status = Number.isInteger(err.status) ? err.status : 500;
  console.error(`[ERROR] ${req.method} ${req.url}:`, err.message || err);
  res.status(status).json({
    success: false,
    error: status === 500 ? "An unexpected server error occurred. Please try again later." : (err.message || "Request failed."),
  });
});

const PORT = Number(process.env.PORT || 3000);

const server = app.listen(PORT, "0.0.0.0", () => {
  purgeExpiredReports();
  purgeExpiredAutomatedHazards();
  console.log(`[SERVER] Alertly running at http://localhost:${PORT}`);
  console.log(`[SERVER] Community reports at http://localhost:${PORT}/report`);
  if (process.env.ENABLE_AUTOMATION === "true") {
    console.log("[SERVER] Initializing background automation...");
    startAutomation();
  } else {
    console.log("[SERVER] Provider automation disabled (set ENABLE_AUTOMATION=true to enable).");
  }
});

setInterval(() => purgeExpiredReports(), 60 * 60 * 1000).unref();
setInterval(() => purgeExpiredAutomatedHazards(), 60 * 60 * 1000).unref();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SERVER] ${signal} received; stopping cleanly...`);
  stopAutomation();
  server.close((error) => {
    if (error) console.error("[SERVER] Shutdown error:", error.message);
    process.exit(error ? 1 : 0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
