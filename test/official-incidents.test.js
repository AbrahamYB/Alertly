import test from "node:test";
import assert from "node:assert/strict";
import { buildFemaFeatures, buildNifcFeatures, classifyFemaIncident } from "../lib/official-incidents.js";

const bbox = [-180, -90, 180, 90];
const cutoffMs = new Date("2026-09-25T00:00:00Z").getTime();

test("FEMA declarations create one verified marker per disaster instead of one per county", () => {
  const rows = ["Alpha County", "Beta County"].map((area, index) => ({
    disasterNumber: 5000,
    femaDeclarationString: "DR-5000-CA",
    state: "CA",
    declarationType: "DR",
    declarationDate: "2026-10-01T00:00:00Z",
    incidentType: "Flood",
    declarationTitle: "SEVERE STORMS AND FLOODING",
    incidentBeginDate: "2026-09-20T00:00:00Z",
    designatedArea: area,
    ihProgramDeclared: index === 0,
  }));
  const features = buildFemaFeatures(rows, { cutoffMs, bbox });
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.hazard, "flood");
  assert.equal(features[0].properties.femaDeclarationVerified, true);
  assert.deepEqual(features[0].properties.designatedAreas, ["Alpha County", "Beta County"]);
});

test("FEMA rejects stale and unsupported declarations", () => {
  assert.equal(classifyFemaIncident("Chemical Spill"), null);
  const rows = [{
    disasterNumber: 4000,
    state: "TX",
    declarationType: "DR",
    declarationDate: "2026-08-01T00:00:00Z",
    incidentType: "Flood",
  }];
  assert.equal(buildFemaFeatures(rows, { cutoffMs, bbox }).length, 0);
});

test("NIFC publishes significant current wildfires and rejects contained or tiny incidents", () => {
  const record = (overrides = {}) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [-120, 45] },
    properties: {
      IncidentTypeCategory: "WF",
      IncidentName: "Example",
      IncidentSize: 2500,
      PercentContained: 40,
      TotalIncidentPersonnel: 30,
      ModifiedOnDateTime_dt: new Date("2026-10-01T00:00:00Z").getTime(),
      FireDiscoveryDateTime: new Date("2026-09-28T00:00:00Z").getTime(),
      IrwinID: "{incident-1}",
      ...overrides,
    },
  });
  const published = buildNifcFeatures([record()], { cutoffMs, bbox });
  assert.equal(published.length, 1);
  assert.equal(published[0].properties.nifcOperationalIncident, true);
  assert.equal(buildNifcFeatures([record({ PercentContained: 100 })], { cutoffMs, bbox }).length, 0);
  assert.equal(buildNifcFeatures([record({ IncidentSize: 25, TotalIncidentPersonnel: 5 })], { cutoffMs, bbox }).length, 0);
});
