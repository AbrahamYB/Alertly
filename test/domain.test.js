import test from "node:test";
import assert from "node:assert/strict";
import { applyReportAiEvaluation, groupNearbyPointHazards, normalizeHazard, normalizeReport, sanitizeReportForPublic } from "../lib/domain.js";

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

test("NASA thermal hotspots are explained as satellite heat detections", () => {
  const hazard = normalizeHazard({
    type: "Feature",
    properties: { hazard: "fire", automated: true, source: "nasa", notes: "Satellite Thermal Hotspot: high temperature" },
    geometry: { type: "Point", coordinates: [-87, 15] },
  });
  assert.match(hazard.properties.title, /Satellite heat detection/);
  assert.equal(hazard.properties.sourceType, "satellite detection");
});

test("nearby point hazards of the same type are grouped automatically", () => {
  const fireA = normalizeHazard({ type: "Feature", id: "a", properties: { hazard: "fire", source: "nasa" }, geometry: { type: "Point", coordinates: [-87, 15] } });
  const fireB = normalizeHazard({ type: "Feature", id: "b", properties: { hazard: "fire", source: "nasa" }, geometry: { type: "Point", coordinates: [-87.05, 15.03] } });
  const quake = normalizeHazard({ type: "Feature", id: "c", properties: { hazard: "earthquake", source: "usgs" }, geometry: { type: "Point", coordinates: [-87.04, 15.02] } });
  const result = groupNearbyPointHazards({ type: "FeatureCollection", features: [fireA, fireB, quake] }, 20);
  assert.equal(result.features.length, 2);
  const group = result.features.find((feature) => feature.properties.grouped);
  assert.equal(group.properties.groupedEventCount, 2);
  assert.deepEqual(group.properties.supportingEvidence.map((item) => item.hazardId).sort(), ["a", "b"]);
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

