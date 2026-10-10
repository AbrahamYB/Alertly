import test from "node:test";
import assert from "node:assert/strict";
import { isPublicGdacsEvent } from "../lib/gdacs-policy.js";

test("GDACS excludes closed events and low-impact green wildfires", () => {
  assert.equal(isPublicGdacsEvent({ eventType: "wf", providerActive: false, alertLevel: "red", burnedArea: 50000, affectedPopulation: 50000 }), false);
  assert.equal(isPublicGdacsEvent({ eventType: "wf", providerActive: true, alertLevel: "green", burnedArea: 5602, affectedPopulation: 0 }), false);
  assert.equal(isPublicGdacsEvent({ eventType: "wf", providerActive: true, alertLevel: "green", burnedArea: 7300, affectedPopulation: 0 }), false);
});

test("GDACS keeps significant active wildfires and active non-fire events", () => {
  assert.equal(isPublicGdacsEvent({ eventType: "wf", providerActive: true, alertLevel: "green", burnedArea: 10000, affectedPopulation: 10000 }), true);
  assert.equal(isPublicGdacsEvent({ eventType: "wf", providerActive: true, alertLevel: "orange", burnedArea: 1, affectedPopulation: 0 }), true);
  assert.equal(isPublicGdacsEvent({ eventType: "eq", providerActive: true, alertLevel: "green", burnedArea: 0, affectedPopulation: 0 }), true);
});
