import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_USGS_MIN_MAGNITUDE, isPublicEarthquake } from "../lib/earthquake-policy.js";

test("USGS microearthquakes do not become public hazard markers", () => {
  assert.equal(DEFAULT_USGS_MIN_MAGNITUDE, 2.5);
  assert.equal(isPublicEarthquake({ mag: 0.6 }), false);
  assert.equal(isPublicEarthquake({ mag: 2.49 }), false);
  assert.equal(isPublicEarthquake({ mag: 2.5 }), true);
  assert.equal(isPublicEarthquake({ mag: 5.1 }), true);
  assert.equal(isPublicEarthquake({ mag: null }), false);
});
