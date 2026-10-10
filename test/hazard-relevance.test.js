import test from "node:test";
import assert from "node:assert/strict";
import {
  isActionableAutomatedHazard,
  isActionableCopernicusActivation,
} from "../lib/hazard-relevance.js";

test("only verified IFRC records become public humanitarian incidents", () => {
  assert.equal(isActionableAutomatedHazard({ properties: { automated: true, source: "ifrc_go", ifrcImpactVerified: true } }), true);
  assert.equal(isActionableAutomatedHazard({ properties: { automated: true, source: "ifrc_go", ifrcImpactVerified: false } }), false);
});

test("Copernicus publishes supported emergency responses and recent closed responses", () => {
  const now = new Date("2026-10-10T00:00:00Z").getTime();
  const retention = 15 * 24 * 60 * 60 * 1000;
  assert.equal(isActionableCopernicusActivation({ hazard: "flood", drmPhase: "response", closed: false }, now, retention), true);
  assert.equal(isActionableCopernicusActivation({ hazard: "other", drmPhase: "response", closed: false }, now, retention), false);
  assert.equal(isActionableCopernicusActivation({ hazard: "fire", drmPhase: "risk", closed: false }, now, retention), false);
  assert.equal(isActionableCopernicusActivation({ hazard: "fire", drmPhase: "response", closed: true, lastUpdate: "2026-10-01T00:00:00Z" }, now, retention), true);
  assert.equal(isActionableCopernicusActivation({ hazard: "fire", drmPhase: "response", closed: true, lastUpdate: "2026-09-01T00:00:00Z" }, now, retention), false);
});

test("unsupported automated detections are excluded even when stored", () => {
  const feature = source => ({ properties: { automated: true, source, hazard: "fire" } });
  assert.equal(isActionableAutomatedHazard(feature("nasa")), false);
  assert.equal(isActionableAutomatedHazard(feature("nasa_eonet")), false);
  assert.equal(isActionableAutomatedHazard(feature("rsoe_edis")), false);
  assert.equal(isActionableAutomatedHazard(feature("usgs")), false);
  assert.equal(isActionableAutomatedHazard(feature("gdacs")), false);
  assert.equal(isActionableAutomatedHazard({ properties: { automated: false, source: "community" } }), true);
});
