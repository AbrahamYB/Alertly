import test from "node:test";
import assert from "node:assert/strict";

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.ALERTLY_TEST_URL || `http://localhost:${PORT}`;

async function createOwnerSession() {
  const bootstrap = await fetch(`${BASE_URL}/api/staff/bootstrap-owner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(bootstrap.status, 201);
  const inviteUrl = (await bootstrap.json()).inviteUrl;
  const token = new URL(inviteUrl).searchParams.get("token");
  assert.ok(token);

  const join = await fetch(`${BASE_URL}/api/staff/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      name: "API Test Owner",
      email: "api-test-owner@example.com",
      password: "api-test-owner-password-123"
    })
  });
  assert.equal(join.status, 201);
  const cookie = join.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

test("GET /health returns healthy service status", async () => {
  const res = await fetch(`${BASE_URL}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.service, "alertly");
});

test("GET /api/auth/status reports authentication requirements and roles", async () => {
  const res = await fetch(`${BASE_URL}/api/auth/status`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(typeof data.isAdmin, "boolean");
  assert.equal(typeof data.isModerator, "boolean");
});

test("GET /api/chat/quota returns daily quota tracking state", async () => {
  const res = await fetch(`${BASE_URL}/api/chat/quota`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.allowed, true);
  assert.equal(typeof data.remaining, "number");
  assert.equal(data.limit, 15);
});

test("Full Community Report lifecycle: publish, removal request, resolution, delete", async () => {
  // 1. Publish a community report
  const reportPayload = {
    type: "Flash Flood",
    text: "River overflowing near bridge",
    severity: "high",
    geometry: {
      type: "Polygon",
      coordinates: [[[-87.65, 15.5], [-87.64, 15.5], [-87.64, 15.49], [-87.65, 15.49], [-87.65, 15.5]]]
    }
  };

  const form = new FormData();
  form.append("reportData", JSON.stringify(reportPayload));

  const pubRes = await fetch(`${BASE_URL}/api/reports/publish`, {
    method: "POST",
    body: form
  });
  assert.equal(pubRes.status, 201);
  const pubData = await pubRes.json();
  assert.equal(pubData.success, true);
  assert.ok(pubData.id);
  const reportId = pubData.id;

  // 2. Submit a removal request
  const remRes = await fetch(`${BASE_URL}/api/removal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reportData: { id: reportId },
      reason: "Flood waters have receded completely."
    })
  });
  assert.equal(remRes.status, 202);
  const remData = await remRes.json();
  assert.equal(remData.success, true);
  assert.equal(remData.queued, true);

  const staffCookie = await createOwnerSession();

  // 3. Inspect moderation report and find removal request
  const modRes = await fetch(`${BASE_URL}/api/moderation/reports`, {
    headers: { Cookie: staffCookie }
  });
  assert.equal(modRes.status, 200);
  const modData = await modRes.json();
  const foundReport = modData.find(r => r.id === reportId);
  assert.ok(foundReport);
  assert.ok(Array.isArray(foundReport.removalRequests));
  assert.equal(foundReport.removalRequests.length, 1);
  const reqId = foundReport.removalRequests[0].id;
  assert.equal(foundReport.removalRequests[0].status, "pending");

  // 4. Resolve removal request (accept)
  const resolveRes = await fetch(`${BASE_URL}/api/moderation/reports/${reportId}/removal-requests/${reqId}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: staffCookie },
    body: JSON.stringify({ action: "accept", note: "Verified area is now clear." })
  });
  assert.equal(resolveRes.status, 200);
  const resolveData = await resolveRes.json();
  assert.equal(resolveData.success, true);
  assert.equal(resolveData.report.isRemoved, true);
  assert.equal(resolveData.report.moderationStatus, "rejected");
  assert.equal(resolveData.report.removalRequests[0].status, "accepted");

  // 5. Clean up test report
  const delRes = await fetch(`${BASE_URL}/api/moderation/reports/${reportId}`, {
    method: "DELETE",
    headers: { Cookie: staffCookie }
  });
  assert.equal(delRes.status, 200);
  const delData = await delRes.json();
  assert.equal(delData.success, true);
  assert.equal(delData.removedId, reportId);
});

test("POST /api/removal requires report and reason", async () => {
  const res = await fetch(`${BASE_URL}/api/removal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.success, false);
});

test("GET /api/reports/data never leaks internal audit logs, submitter IP, or removal requests to browsers", async () => {
  const res = await fetch(`${BASE_URL}/api/reports/data`);
  assert.equal(res.status, 200);
  const reports = await res.json();
  assert.ok(Array.isArray(reports));
  assert.ok(reports.length > 0, "Seed reports should be present");

  for (const report of reports) {
    // Assert strictly that zero sensitive server data is leaked
    assert.equal(report.auditLog, undefined, "Public report must NOT contain auditLog");
    assert.equal(report.removalRequests, undefined, "Public report must NOT contain removalRequests");
    assert.equal(report.submitterIp, undefined, "Public report must NOT contain submitterIp");
    assert.equal(report.moderatorNotes, undefined, "Public report must NOT contain moderatorNotes");

    // Standard public viewing fields must exist
    assert.ok(report.id);
    assert.ok(report.type);
    assert.ok(report.geometry);
  }
});

