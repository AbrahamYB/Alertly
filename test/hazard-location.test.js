import test from "node:test";
import assert from "node:assert/strict";
import { resolveCopernicusEventLocation } from "../lib/hazard-location.js";

test("Fuego activations use the authoritative summit location", () => {
  const location = resolveCopernicusEventLocation({
    hazard: "volcano",
    title: "Volcano eruption in Guatemala",
    areaNames: ["Yepocapa", "El Fuego"],
    providerCoordinates: [-90.90488258150785, 14.467714085412526],
  });
  assert.deepEqual(location.coordinates, [-90.8806, 14.4748]);
  assert.equal(location.estimated, false);
  assert.equal(location.source, "Smithsonian Global Volcanism Program");
});

test("unresolved activations retain the provider center and disclose approximation", () => {
  const providerCoordinates = [-88.2, 15.4];
  const location = resolveCopernicusEventLocation({
    hazard: "flood",
    title: "Flood activation",
    providerCoordinates,
  });
  assert.deepEqual(location.coordinates, providerCoordinates);
  assert.equal(location.estimated, true);
});
