import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createStaffAccess } from "../lib/staff-access.js";

function createHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alertly-staff-access-"));
  const access = createStaffAccess({
    stateFile: path.join(directory, "staff-access.json"),
    auditFile: path.join(directory, "audit.jsonl"),
    sessionTtlMs: 60_000,
    inviteTtlMs: 60_000,
    transferTtlMs: 60_000,
  });
  return { directory, access, context: { ip: "127.0.0.1", userAgent: "test" } };
}

test("invite-only accounts create one Owner and individual Staff sessions", async (t) => {
  const { directory, access, context } = createHarness();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const ownerInvite = access.createInvitation({ role: "owner", allowBootstrap: true, context });
  const ownerResult = await access.acceptInvitation({
    token: ownerInvite.token,
    name: "Alertly Owner",
    email: "owner@example.com",
    password: "owner-password-123",
    context,
  });
  assert.equal(ownerResult.user.role, "owner");
  assert.equal(access.getSession(ownerResult.token).user.email, "owner@example.com");

  const staffInvite = access.createInvitation({ actor: ownerResult.user, email: "staff@example.com", context });
  const staffResult = await access.acceptInvitation({
    token: staffInvite.token,
    name: "Alertly Staff",
    email: "staff@example.com",
    password: "staff-password-123",
    context,
  });
  assert.equal(staffResult.user.role, "staff");
  await assert.rejects(
    access.acceptInvitation({ token: staffInvite.token, name: "Replay", email: "staff2@example.com", password: "staff-password-456", context }),
    /invalid, expired, or already used/,
  );
});

test("ownership transfer requires both parties and revokes their sessions", async (t) => {
  const { directory, access, context } = createHarness();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const ownerInvite = access.createInvitation({ role: "owner", allowBootstrap: true, context });
  const owner = await access.acceptInvitation({ token: ownerInvite.token, name: "First Owner", email: "first@example.com", password: "first-password-123", context });
  const staffInvite = access.createInvitation({ actor: owner.user, email: "next@example.com", context });
  const staff = await access.acceptInvitation({ token: staffInvite.token, name: "Next Owner", email: "next@example.com", password: "next-password-123", context });

  const transfer = await access.beginTransfer({ actor: owner.user, targetUserId: staff.user.id, password: "first-password-123", context });
  assert.equal(access.getPendingTransfer(staff.user.id).id, transfer.id);
  const result = await access.acceptTransfer({ actor: staff.user, transferId: transfer.id, password: "next-password-123", context });
  assert.equal(result.owner.role, "owner");
  assert.equal(result.previousOwner.role, "staff");
  assert.equal(access.getSession(owner.token), null);
  assert.equal(access.getSession(staff.token), null);

  const accounts = access.listAccounts();
  assert.equal(accounts.filter((account) => account.role === "owner").length, 1);
  assert.ok(access.readAudit(100).some((event) => event.action === "owner.transfer_accepted"));
});
