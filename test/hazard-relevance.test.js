import test from "node:test";
import assert from "node:assert/strict";
import {
  isActionableAutomatedHazard,
  isActionableCopernicusActivation,
  isActionableGdacsEvent,
} from "../lib/hazard-relevance.js";

test("GDACS green monitoring events stay off the public incident map", () => {
  assert.equal(isActionableGdacsEvent({ providerActive: true, alertLevel: "green" }), false);
  assert.equal(isActionableGdacsEvent({ providerActive: true, alertLevel: "orange" }), true);
  assert.equal(isActionableGdacsEvent({ providerActive: true, alertLevel: "red" }), true);
  assert.equal(isActionableGdacsEvent({ providerActive: false, alertLevel: "red" }), false);
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
  assert.equal(isActionableAutomatedHazard({ properties: { automated: false, source: "community" } }), true);
});
