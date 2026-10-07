import crypto from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { replaceFileSync } from "./file-utils.js";

const scrypt = promisify(crypto.scrypt);
const DEFAULT_STATE = { version: 1, users: [], invitations: [], sessions: [], transfers: [] };

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 100);
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeEqualHex(left, right) {
  try {
    const a = Buffer.from(String(left), "hex");
    const b = Buffer.from(String(right), "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = await scrypt(String(password), salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return { salt, hash: Buffer.from(derived).toString("hex") };
}

async function verifyPassword(password, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  const candidate = await hashPassword(password, stored.salt);
  return safeEqualHex(candidate.hash, stored.hash);
}

export function createStaffAccess({
  stateFile,
  auditFile,
  sessionTtlMs = 12 * 60 * 60 * 1000,
  inviteTtlMs = 24 * 60 * 60 * 1000,
  transferTtlMs = 24 * 60 * 60 * 1000,
}) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  if (!fs.existsSync(stateFile)) fs.writeFileSync(stateFile, `${JSON.stringify(DEFAULT_STATE, null, 2)}\n`, { mode: 0o600 });
  if (!fs.existsSync(auditFile)) fs.writeFileSync(auditFile, "", { mode: 0o600 });
  try { fs.chmodSync(stateFile, 0o600); } catch (_) {}
  try { fs.chmodSync(auditFile, 0o600); } catch (_) {}

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return {
        version: 1,
        users: Array.isArray(parsed.users) ? parsed.users : [],
        invitations: Array.isArray(parsed.invitations) ? parsed.invitations : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        transfers: Array.isArray(parsed.transfers) ? parsed.transfers : [],
      };
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  function writeState(state) {
    const temp = `${stateFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    replaceFileSync(temp, stateFile);
  }

  function contextFromRequest(req) {
    return {
      ip: String(req?.ip || req?.socket?.remoteAddress || "unknown").slice(0, 120),
      userAgent: String(req?.headers?.["user-agent"] || "unknown").slice(0, 300),
    };
  }

  function audit({ action, actor = null, target = null, outcome = "success", details = {}, context = {} }) {
    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      action: String(action),
      outcome: String(outcome),
      actor: actor ? { id: actor.id || null, email: actor.email || null, role: actor.role || null } : null,
      target: target ? { id: target.id || null, email: target.email || null, type: target.type || null } : null,
      context: { ip: context.ip || "unknown", userAgent: context.userAgent || "unknown" },
      details,
    };
    fs.appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }

  function publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      disabledAt: user.disabledAt || null,
    };
  }

  function cleanup(state, now = Date.now()) {
    state.sessions = state.sessions.filter((session) => session.expiresAt > now);
    state.invitations = state.invitations.slice(-200);
    state.transfers = state.transfers.slice(-100);
  }

  function getSession(rawToken, { touch = true } = {}) {
    if (!rawToken) return null;
    const state = readState();
    cleanup(state);
    const tokenHash = hashToken(rawToken);
    const session = state.sessions.find((item) => safeEqualHex(item.tokenHash, tokenHash));
    if (!session) return null;
    const user = state.users.find((item) => item.id === session.userId && !item.disabledAt);
    if (!user) return null;
    if (touch && Date.now() - Number(session.lastSeenAt || 0) > 5 * 60 * 1000) {
      session.lastSeenAt = Date.now();
      writeState(state);
    }
    return { session, user: publicUser(user) };
  }

  function issueSession(state, user, context) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    state.sessions.push({
      id: crypto.randomUUID(),
      tokenHash: hashToken(token),
      userId: user.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + sessionTtlMs,
      context,
    });
    return token;
  }

  async function signIn({ email, password, context }) {
    const normalizedEmail = cleanEmail(email);
    const state = readState();
    cleanup(state);
    const user = state.users.find((item) => item.email === normalizedEmail);
    const valid = user && !user.disabledAt && await verifyPassword(password, user.password);
    if (!valid) {
      audit({ action: "staff.login", outcome: "failure", target: { email: normalizedEmail, type: "account" }, context });
      return null;
    }
    const token = issueSession(state, user, context);
    writeState(state);
    audit({ action: "staff.login", actor: user, target: { id: user.id, email: user.email, type: "account" }, context });
    return { token, user: publicUser(user) };
  }

  function signOut(rawToken, context) {
    const state = readState();
    const tokenHash = hashToken(rawToken);
    const session = state.sessions.find((item) => safeEqualHex(item.tokenHash, tokenHash));
    const user = session ? state.users.find((item) => item.id === session.userId) : null;
    state.sessions = state.sessions.filter((item) => !safeEqualHex(item.tokenHash, tokenHash));
    writeState(state);
    if (user) audit({ action: "staff.logout", actor: user, target: { id: user.id, email: user.email, type: "account" }, context });
  }

  function createInvitation({ actor, email = "", role = "staff", context, allowBootstrap = false }) {
    const state = readState();
    cleanup(state);
    const ownerExists = state.users.some((user) => user.role === "owner" && !user.disabledAt);
    if (role === "owner" && (ownerExists || !allowBootstrap)) throw new Error("Owner invitation is not available.");
    if (role !== "staff" && role !== "owner") throw new Error("Invalid invitation role.");
    const normalizedEmail = cleanEmail(email);
    if (normalizedEmail && state.users.some((user) => user.email === normalizedEmail)) throw new Error("An account already uses that email.");

    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const invitation = {
      id: crypto.randomUUID(),
      tokenHash: hashToken(token),
      email: normalizedEmail || null,
      role,
      createdAt: now,
      expiresAt: now + inviteTtlMs,
      createdBy: actor?.id || "bootstrap",
      usedAt: null,
      revokedAt: null,
    };
    state.invitations.push(invitation);
    writeState(state);
    audit({
      action: role === "owner" ? "owner.bootstrap_invitation_created" : "staff.invitation_created",
      actor,
      target: { id: invitation.id, email: invitation.email, type: "invitation" },
      details: { role, expiresAt: new Date(invitation.expiresAt).toISOString() },
      context,
    });
    return { token, invitation: { ...invitation, tokenHash: undefined } };
  }

  async function acceptInvitation({ token, name, email, password, context }) {
    const normalizedEmail = cleanEmail(email);
    const normalizedName = cleanName(name);
    if (!normalizedName) throw new Error("Name is required.");
    if (!normalizedEmail || !normalizedEmail.includes("@")) throw new Error("A valid email address is required.");
    if (String(password || "").length < 12) throw new Error("Password must be at least 12 characters.");
    if (String(password || "").length > 128) throw new Error("Password is too long.");

    const state = readState();
    cleanup(state);
    const tokenHash = hashToken(token);
    const invitation = state.invitations.find((item) => safeEqualHex(item.tokenHash, tokenHash));
    if (!invitation || invitation.usedAt || invitation.revokedAt || invitation.expiresAt <= Date.now()) {
      audit({ action: "staff.invitation_accepted", outcome: "failure", target: { email: normalizedEmail, type: "invitation" }, context });
      throw new Error("This invitation is invalid, expired, or already used.");
    }
    if (invitation.email && invitation.email !== normalizedEmail) throw new Error("Use the email address this invitation was created for.");
    if (state.users.some((user) => user.email === normalizedEmail)) throw new Error("An account already uses that email.");
    if (invitation.role === "owner" && state.users.some((user) => user.role === "owner" && !user.disabledAt)) {
      throw new Error("An Owner account already exists.");
    }

    const now = Date.now();
    const user = {
      id: crypto.randomUUID(),
      name: normalizedName,
      email: normalizedEmail,
      role: invitation.role,
      password: await hashPassword(password),
      createdAt: now,
      disabledAt: null,
    };
    invitation.usedAt = now;
    invitation.usedBy = user.id;
    state.users.push(user);
    const sessionToken = issueSession(state, user, context);
    writeState(state);
    audit({ action: "staff.account_created", actor: user, target: { id: user.id, email: user.email, type: "account" }, details: { role: user.role }, context });
    return { token: sessionToken, user: publicUser(user) };
  }

  function listAccounts() {
    const state = readState();
    const activeSessions = new Map();
    for (const session of state.sessions.filter((item) => item.expiresAt > Date.now())) {
      activeSessions.set(session.userId, (activeSessions.get(session.userId) || 0) + 1);
    }
    return state.users.map((user) => ({ ...publicUser(user), activeSessions: activeSessions.get(user.id) || 0 }));
  }

  function listInvitations() {
    return readState().invitations.slice(-50).reverse().map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      usedAt: invitation.usedAt,
      revokedAt: invitation.revokedAt,
    }));
  }

  function revokeInvitation({ id, actor, context }) {
    const state = readState();
    const invitation = state.invitations.find((item) => item.id === id);
    if (!invitation || invitation.usedAt) throw new Error("Pending invitation not found.");
    invitation.revokedAt = Date.now();
    writeState(state);
    audit({ action: "staff.invitation_revoked", actor, target: { id, email: invitation.email, type: "invitation" }, context });
  }

  function setDisabled({ userId, disabled, actor, context }) {
    const state = readState();
    const user = state.users.find((item) => item.id === userId);
    if (!user) throw new Error("Staff account not found.");
    if (user.role === "owner") throw new Error("Transfer ownership before disabling the Owner account.");
    user.disabledAt = disabled ? Date.now() : null;
    if (disabled) state.sessions = state.sessions.filter((session) => session.userId !== user.id);
    writeState(state);
    audit({ action: disabled ? "staff.account_disabled" : "staff.account_restored", actor, target: { id: user.id, email: user.email, type: "account" }, context });
    return publicUser(user);
  }

  async function beginTransfer({ actor, targetUserId, password, context }) {
    const state = readState();
    cleanup(state);
    const owner = state.users.find((user) => user.id === actor.id && user.role === "owner" && !user.disabledAt);
    if (!owner || !await verifyPassword(password, owner.password)) throw new Error("Owner re-authentication failed.");
    const target = state.users.find((user) => user.id === targetUserId && user.role === "staff" && !user.disabledAt);
    if (!target) throw new Error("Choose an active Staff account.");
    const now = Date.now();
    for (const transfer of state.transfers) {
      if (!transfer.acceptedAt && !transfer.cancelledAt && transfer.expiresAt > now) transfer.cancelledAt = now;
    }
    const transfer = {
      id: crypto.randomUUID(),
      fromUserId: owner.id,
      toUserId: target.id,
      createdAt: now,
      expiresAt: now + transferTtlMs,
      acceptedAt: null,
      cancelledAt: null,
    };
    state.transfers.push(transfer);
    writeState(state);
    audit({ action: "owner.transfer_started", actor: owner, target: { id: target.id, email: target.email, type: "account" }, details: { transferId: transfer.id, expiresAt: new Date(transfer.expiresAt).toISOString() }, context });
    return transfer;
  }

  function getPendingTransfer(userId) {
    const state = readState();
    const transfer = [...state.transfers].reverse().find((item) => !item.acceptedAt && !item.cancelledAt && item.expiresAt > Date.now() && (item.fromUserId === userId || item.toUserId === userId));
    if (!transfer) return null;
    const from = state.users.find((user) => user.id === transfer.fromUserId);
    const to = state.users.find((user) => user.id === transfer.toUserId);
    return { ...transfer, from: publicUser(from), to: publicUser(to) };
  }

  async function acceptTransfer({ actor, transferId, password, context }) {
    const state = readState();
    const transfer = state.transfers.find((item) => item.id === transferId && !item.acceptedAt && !item.cancelledAt && item.expiresAt > Date.now());
    if (!transfer || transfer.toUserId !== actor.id) throw new Error("Pending ownership transfer not found.");
    const recipient = state.users.find((user) => user.id === actor.id && user.role === "staff" && !user.disabledAt);
    const owner = state.users.find((user) => user.id === transfer.fromUserId && user.role === "owner" && !user.disabledAt);
    if (!recipient || !owner || !await verifyPassword(password, recipient.password)) throw new Error("Re-authentication failed.");
    owner.role = "staff";
    recipient.role = "owner";
    transfer.acceptedAt = Date.now();
    state.sessions = state.sessions.filter((session) => session.userId !== owner.id && session.userId !== recipient.id);
    writeState(state);
    audit({ action: "owner.transfer_accepted", actor: recipient, target: { id: owner.id, email: owner.email, type: "account" }, details: { transferId }, context });
    return { previousOwner: publicUser(owner), owner: publicUser(recipient) };
  }

  function cancelTransfer({ actor, transferId, context }) {
    const state = readState();
    const transfer = state.transfers.find((item) => item.id === transferId && !item.acceptedAt && !item.cancelledAt && item.expiresAt > Date.now());
    if (!transfer || transfer.fromUserId !== actor.id) throw new Error("Pending ownership transfer not found.");
    transfer.cancelledAt = Date.now();
    writeState(state);
    audit({ action: "owner.transfer_cancelled", actor, target: { id: transfer.toUserId, type: "account" }, details: { transferId }, context });
  }

  function readAudit(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const text = fs.readFileSync(auditFile, "utf8").trim();
    if (!text) return [];
    return text.split("\n").slice(-safeLimit).reverse().flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }

  function hasAnyUsers() {
    return readState().users.length > 0;
  }

  return {
    acceptInvitation,
    acceptTransfer,
    audit,
    beginTransfer,
    cancelTransfer,
    contextFromRequest,
    createInvitation,
    getPendingTransfer,
    getSession,
    hasAnyUsers,
    listAccounts,
    listInvitations,
    readAudit,
    revokeInvitation,
    setDisabled,
    signIn,
    signOut,
  };
}
