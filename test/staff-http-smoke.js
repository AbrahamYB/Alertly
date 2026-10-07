import assert from "node:assert/strict";

const base = process.env.ALERTLY_TEST_URL || "http://127.0.0.1:3100";

async function request(path, { cookie = "", body, redirect = "follow" } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect,
  });
  const data = String(response.headers.get("content-type") || "").includes("application/json")
    ? await response.json()
    : null;
  return { response, data, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || "" };
}

let ownerInviteUrl = process.env.ALERTLY_OWNER_INVITE_URL || "";
if (!ownerInviteUrl) {
  const bootstrap = await request("/api/staff/bootstrap-owner", { body: {} });
  assert.equal(bootstrap.response.status, 201);
  ownerInviteUrl = bootstrap.data.inviteUrl;
}
const ownerToken = new URL(ownerInviteUrl).searchParams.get("token");
assert.ok(ownerToken);

const ownerJoin = await request("/api/staff/join", {
  body: { token: ownerToken, name: "Smoke Test Owner", email: "owner-smoke@example.com", password: "owner-smoke-password-123" },
});
assert.equal(ownerJoin.response.status, 201);
assert.equal(ownerJoin.data.user.role, "owner");
assert.ok(ownerJoin.cookie);

const invite = await request("/api/staff/invitations", {
  cookie: ownerJoin.cookie,
  body: { email: "staff-smoke@example.com" },
});
assert.equal(invite.response.status, 201);
const staffToken = new URL(invite.data.inviteUrl).searchParams.get("token");

const staffJoin = await request("/api/staff/join", {
  body: { token: staffToken, name: "Smoke Test Staff", email: "staff-smoke@example.com", password: "staff-smoke-password-123" },
});
assert.equal(staffJoin.response.status, 201);
assert.equal(staffJoin.data.user.role, "staff");

const protectedWithoutSession = await request("/hazard-admin", { redirect: "manual" });
assert.equal(protectedWithoutSession.response.status, 302);
assert.match(protectedWithoutSession.response.headers.get("location"), /^\/staff\?returnTo=/);

const protectedWithSession = await request("/hazard-admin", { cookie: staffJoin.cookie, redirect: "manual" });
assert.equal(protectedWithSession.response.status, 200);

const accounts = await request("/api/staff/accounts", { cookie: ownerJoin.cookie });
assert.equal(accounts.response.status, 200);
const target = accounts.data.accounts.find((account) => account.email === "staff-smoke@example.com");
assert.ok(target);

const transfer = await request("/api/staff/ownership-transfer", {
  cookie: ownerJoin.cookie,
  body: { targetUserId: target.id, password: "owner-smoke-password-123" },
});
assert.equal(transfer.response.status, 201);

const accepted = await request(`/api/staff/ownership-transfer/${transfer.data.transfer.id}/accept`, {
  cookie: staffJoin.cookie,
  body: { password: "staff-smoke-password-123" },
});
assert.equal(accepted.response.status, 200);
assert.equal(accepted.data.owner.email, "staff-smoke@example.com");
assert.equal(accepted.data.previousOwner.role, "staff");

const formerSession = await request("/api/staff/session", { cookie: ownerJoin.cookie });
const newOwnerSession = await request("/api/staff/session", { cookie: staffJoin.cookie });
assert.equal(formerSession.data.authenticated, false);
assert.equal(newOwnerSession.data.authenticated, false);

console.log("Staff HTTP smoke test passed.");
