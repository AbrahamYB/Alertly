import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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

test("POST /chat rejects obvious off-topic use without consuming AI quota", async () => {
  const before = await (await fetch(`${BASE_URL}/api/chat/quota`)).json();
  const res = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message: "Write Python code for a video game", responseMode: "json" }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.scopeRestricted, true);
  assert.match(data.reply, /environmental hazards/);
  const after = await (await fetch(`${BASE_URL}/api/chat/quota`)).json();
  assert.equal(after.used, before.used);
});

test("Moderation data is unavailable without staff authentication", async () => {
  const res = await fetch(`${BASE_URL}/api/moderation/reports`);
  assert.notEqual(res.status, 200);
});

test("validation-only and rejected report uploads leave no files behind", async () => {
  const uploadsDir = process.env.UPLOADS_DIR;
  assert.ok(uploadsDir);
  const originalFiles = fs.readdirSync(uploadsDir).sort();
  const validGeometry = {
    type: "Polygon",
    coordinates: [[[-87.65, 15.5], [-87.64, 15.5], [-87.64, 15.49], [-87.65, 15.49], [-87.65, 15.5]]],
  };

  const validateForm = new FormData();
  validateForm.append("reportData", JSON.stringify({ type: "Flood", text: "Validation only", geometry: validGeometry }));
  validateForm.append("images", new Blob(["not-retained"], { type: "image/jpeg" }), "validation.jpg");
  const validateResponse = await fetch(`${BASE_URL}/api/reports/publish?validate=true`, { method: "POST", body: validateForm });
  assert.equal(validateResponse.status, 200);
  assert.deepEqual(fs.readdirSync(uploadsDir).sort(), originalFiles);

  const rejectedForm = new FormData();
  rejectedForm.append("reportData", JSON.stringify({ type: "Flood", text: "Invalid point", geometry: { type: "Point", coordinates: [-87.65, 15.5] } }));
  rejectedForm.append("images", new Blob(["also-not-retained"], { type: "image/jpeg" }), "rejected.jpg");
  const rejectedResponse = await fetch(`${BASE_URL}/api/reports/publish`, { method: "POST", body: rejectedForm });
  assert.equal(rejectedResponse.status, 400);
  assert.deepEqual(fs.readdirSync(uploadsDir).sort(), originalFiles);
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
  assert.equal(pubData.report.publiclyVisible, false);
  assert.equal(pubData.report.moderationStatus, "pending");

  const unverifiedPublic = await (await fetch(`${BASE_URL}/api/reports/data`)).json();
  assert.equal(unverifiedPublic.some(report => report.id === reportId), false, "Unverified reports must remain moderation-only");

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

  const invalidSeverityRes = await fetch(`${BASE_URL}/api/moderation/reports/${reportId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: staffCookie },
    body: JSON.stringify({ severity: "catastrophic" })
  });
  assert.equal(invalidSeverityRes.status, 400);

  // Rejected reports disappear from the public map immediately, and restoring
  // them makes them public again without stale cache state.
  const rejectRes = await fetch(`${BASE_URL}/api/moderation/reports/${reportId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: staffCookie },
    body: JSON.stringify({ moderationStatus: "rejected", action: "rejected-test" })
  });
  assert.equal(rejectRes.status, 200);
  const rejectedPublic = await (await fetch(`${BASE_URL}/api/reports/data`)).json();
  assert.equal(rejectedPublic.some(report => report.id === reportId), false);
  const rejectedBypassAttempt = await (await fetch(`${BASE_URL}/api/reports/data?includeRemoved=true`)).json();
  assert.equal(rejectedBypassAttempt.some(report => report.id === reportId), false, "Public query parameters cannot expose rejected reports");

  const restoreRes = await fetch(`${BASE_URL}/api/moderation/reports/${reportId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: staffCookie },
    body: JSON.stringify({ moderationStatus: "approved", action: "restored-test" })
  });
  assert.equal(restoreRes.status, 200);
  const restoredPublic = await (await fetch(`${BASE_URL}/api/reports/data`)).json();
  assert.equal(restoredPublic.some(report => report.id === reportId), true);
  const mainMapHazards = await (await fetch(`${BASE_URL}/hazards/data?bbox=-87.66,15.48,-87.63,15.51&zoom=12`)).json();
  assert.equal(mainMapHazards.features.some(feature => feature.properties?.reportId === reportId), true, "Approved community reports must appear on the main map feed");

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

