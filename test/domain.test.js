import test from "node:test";
import assert from "node:assert/strict";
import { HAZARD_PUBLIC_LIFETIME_MS, applyReportAiEvaluation, compactHazardForPublic, isDeprecatedHazardFeature, isHazardCurrent, isReportPublic, normalizeHazard, normalizeReport, reconcileReportVisibility, sanitizeReportForPublic } from "../lib/domain.js";

test("legacy hazard is upgraded to the unified model", () => {
  const hazard = normalizeHazard({
    type: "Feature",
    properties: { hazard: "fire", automated: true, source: "nasa", extId: "abc", notes: "Hotspot" },
    geometry: { type: "Point", coordinates: [-87, 15] },
  }, new Date("2026-01-01T00:00:00Z"));
  assert.equal(hazard.id, "abc");
  assert.equal(hazard.properties.confidence, "probable");
  assert.equal(hazard.properties.status, "active");
  assert.equal(hazard.properties.description, "Hotspot");
});

test("legacy Copernicus AOI coverage overlays are deprecated", () => {
  const legacyAoi = {
    type: "Feature",
    properties: { source: "copernicus", extId: "ems_aoi_0_EMSR912" },
    geometry: { type: "Polygon", coordinates: [[[-91, 14], [-90, 14], [-90, 15], [-91, 14]]] },
  };
  assert.equal(isDeprecatedHazardFeature(legacyAoi), true);
  assert.equal(isDeprecatedHazardFeature(normalizeHazard(legacyAoi)), true);
  assert.equal(isDeprecatedHazardFeature({ ...legacyAoi, properties: { source: "admin", extId: "ems_aoi_manual" } }), false);
});

test("NASA thermal hotspots are explained as satellite heat detections", () => {
  const hazard = normalizeHazard({
    type: "Feature",
    properties: { hazard: "fire", automated: true, source: "nasa", notes: "Satellite Thermal Hotspot: high temperature" },
    geometry: { type: "Point", coordinates: [-87, 15] },
  });
  assert.match(hazard.properties.title, /Satellite heat detection/);
  assert.equal(hazard.properties.sourceType, "satellite detection");
});

test("hazards leave the public map after 15 days without renewed evidence", () => {
  const now = new Date("2026-02-01T00:00:00Z").getTime();
  const active = normalizeHazard({
    type: "Feature",
    properties: { hazard: "flood", lastSeenAt: new Date(now - HAZARD_PUBLIC_LIFETIME_MS + 1000).toISOString() },
    geometry: { type: "Point", coordinates: [-87, 15] },
  });
  const expired = normalizeHazard({
    type: "Feature",
    properties: { hazard: "flood", lastSeenAt: new Date(now - HAZARD_PUBLIC_LIFETIME_MS).toISOString() },
    geometry: { type: "Point", coordinates: [-87, 15] },
  });
  assert.equal(isHazardCurrent(active, now), true);
  assert.equal(isHazardCurrent(expired, now), false);
});

test("public hazards omit internal evidence detail", () => {
  const compact = compactHazardForPublic(normalizeHazard({
    type: "Feature",
    id: "grouped",
    properties: {
      hazard: "fire",
      notes: "Visible summary",
      extId: "private-provider-id",
      supportingEvidence: [
        { source: "nasa", sourceUrl: "https://example.test/a", coordinates: [-87, 15] },
        { source: "nasa" },
        { source: "gdacs" },
      ],
      grouped: true,
      groupedEventCount: 3,
    },
    geometry: { type: "Point", coordinates: [-87, 15] },
  }));
  assert.equal(compact.properties.description, "Visible summary");
  assert.deepEqual(compact.properties.evidenceSources, ["nasa", "gdacs"]);
  assert.equal(compact.properties.extId, undefined);
  assert.equal(compact.properties.supportingEvidence, undefined);
});

test("legacy coordinate report becomes point geometry", () => {
  const report = normalizeReport({ type: "Flood", text: "Road flooded", lat: 15, lng: -87, createdAt: 1 });
  assert.deepEqual(report.geometry, { type: "Point", coordinates: [-87, 15] });
  assert.equal(typeof report.createdAt, "number");
  assert.equal(report.moderationStatus, "pending");
  assert.equal("aiModeration" in report, false);
});

test("legacy removed reports enter moderation as rejected", () => {
  const report = normalizeReport({ id: "old-report", text: "old", lat: 15, lng: -88, isRemoved: true });
  assert.equal(report.moderationStatus, "rejected");
});

test("NSFW AI verdict immediately quarantines a report but preserves it for staff review", () => {
  const report = normalizeReport({ id: "unsafe", type: "Other", text: "media", lat: 15, lng: -88 });
  const quarantined = applyReportAiEvaluation(report, { verdict: "nsfw", confidence: 91, reason: "Explicit content appears in a sampled frame." }, new Date("2026-01-01T00:00:00Z"));
  assert.equal(quarantined.isRemoved, true);
  assert.equal(quarantined.moderationStatus, "rejected");
  assert.equal(quarantined.aiEvaluation.verdict, "nsfw");
  assert.equal(quarantined.auditLog.at(-1).action, "ai-nsfw-quarantine");
});

test("public report visibility follows one moderation rule", () => {
  const base = normalizeReport({ id: "visibility", type: "Flood", text: "Water on road", lat: 15, lng: -88 });
  assert.equal(isReportPublic(base), false, "unverified pending reports stay in moderation");
  const plausible = applyReportAiEvaluation(base, { verdict: "plausible", confidence: 88, reason: "Consistent evidence." });
  assert.equal(isReportPublic(plausible), true);
  assert.equal(plausible.moderationStatus, "approved", "AI-passed reports must not look pending to moderators");
  assert.equal(plausible.verified, true);
  assert.equal(isReportPublic(applyReportAiEvaluation(base, { verdict: "suspicious", confidence: 70, reason: "Conflicting evidence." })), false);
  assert.equal(isReportPublic({ ...base, moderationStatus: "approved", verified: true }), true);
  assert.equal(isReportPublic({ ...base, moderationStatus: "approved", verified: true, publiclyVisible: false }), true, "approved status wins over stale visibility data");
  assert.equal(isReportPublic({ ...base, moderationStatus: "rejected", publiclyVisible: true }), false);
  assert.equal(isReportPublic({ ...base, isRemoved: true, publiclyVisible: true }), false);
});

test("legacy report visibility is reconciled to the same public rule", () => {
  const plausible = reconcileReportVisibility({ moderationStatus: "pending", aiEvaluation: { verdict: "plausible" } });
  assert.equal(plausible.moderationStatus, "approved");
  assert.equal(plausible.publiclyVisible, true);
  assert.equal(plausible.verified, true);

  const unverified = reconcileReportVisibility({ moderationStatus: "pending", aiEvaluation: { verdict: "unverified" } });
  assert.equal(unverified.publiclyVisible, false);
  assert.equal(unverified.verified, false);

  const manuallyPending = reconcileReportVisibility({ moderationStatus: "pending", publiclyVisible: false, aiEvaluation: { verdict: "plausible" } });
  assert.equal(manuallyPending.moderationStatus, "pending");
  assert.equal(manuallyPending.publiclyVisible, false);
});

test("report without a location is rejected", () => {
  assert.throws(
    () => normalizeReport({ type: "Flood", text: "Missing location" }),
    /valid latitude and longitude/,
  );
});

test("line report keeps geometry and derives a filter center", () => {
  const report = normalizeReport({
    type: "Blocked road",
    text: "Road is inaccessible",
    geometry: { type: "LineString", coordinates: [[-88, 14], [-86, 16]] },
  });
  assert.equal(report.geometry.type, "LineString");
  assert.equal(report.lng, -87);
  assert.equal(report.lat, 15);
});

test("incomplete line and area reports are rejected", () => {
  assert.throws(
    () => normalizeReport({ geometry: { type: "LineString", coordinates: [[-87, 15]] } }),
    /at least two points/,
  );
  assert.throws(
    () => normalizeReport({ geometry: { type: "Polygon", coordinates: [[[-87, 15], [-86, 15]]] } }),
    /at least three points/,
  );
});

test("sanitizeReportForPublic removes audit logs, internal notes, and removal request details", () => {
  const internalReport = {
    id: "rep_sensitive_test",
    type: "🔥 Fire",
    text: "Public fire description",
    lat: 14.5,
    lng: -87.5,
    geometry: { type: "Point", coordinates: [-87.5, 14.5] },
    auditLog: [
      { id: "log_1", action: "moderated", actor: "SuperAdmin", note: "Internal decision rationale" }
    ],
    removalRequests: [
      { id: "req_1", reason: "Private phone number visible", status: "pending" }
    ],
    submitterIp: "192.168.1.100",
    moderatorNotes: "Flagged by automatic heuristic",
  };

  const clean = sanitizeReportForPublic(internalReport);

  // Sensitive internal fields must be completely stripped
  assert.equal(clean.auditLog, undefined);
  assert.equal(clean.removalRequests, undefined);
  assert.equal(clean.submitterIp, undefined);
  assert.equal(clean.moderatorNotes, undefined);

  // Public fields must remain intact
  assert.equal(clean.id, "rep_sensitive_test");
  assert.equal(clean.text, "Public fire description");
  assert.equal(clean.hasRemovalRequest, true);
});

test("sanitizeReportForPublic preserves legacy string attachment URLs", () => {
  const clean = sanitizeReportForPublic({
    id: "legacy-media",
    type: "Flood",
    text: "Legacy upload",
    lat: 15,
    lng: -88,
    moderationStatus: "approved",
    images: ["/uploads/legacy.jpg"],
  });
  assert.deepEqual(clean.images, [{ url: "/uploads/legacy.jpg", name: "Attachment", type: "image", size: undefined }]);
});

