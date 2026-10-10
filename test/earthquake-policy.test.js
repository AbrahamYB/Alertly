import test from "node:test";
import assert from "node:assert/strict";
import { isPublicEarthquake } from "../lib/earthquake-policy.js";

test("USGS publishes impact alerts rather than magnitude-only detections", () => {
  assert.equal(isPublicEarthquake({ mag: 0.6, alert: null }), false);
  assert.equal(isPublicEarthquake({ mag: 7.0, alert: "green" }), false);
  assert.equal(isPublicEarthquake({ mag: 4.2, alert: "yellow" }), true);
  assert.equal(isPublicEarthquake({ alert: "orange" }), true);
  assert.equal(isPublicEarthquake({ pagerAlert: "red" }), true);
});
