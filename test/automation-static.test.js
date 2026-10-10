import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("every documented hazard provider is connected to the refresh cycle", () => {
  const source = fs.readFileSync(path.join(projectRoot, "automation.js"), "utf8");
  for (const call of [
    "await fetchUSGSEarthquakes()",
    "await fetchNASAFires()",
    "await fetchNASAEonet()",
    "await fetchRSOEEDIS()",
    "await fetchCopernicusEMS()",
  ]) {
    assert.ok(source.includes(call), `automation refresh is missing ${call}`);
  }
  assert.ok(source.includes("www.gdacs.org/xml/rss.xml"), "automation refresh is missing GDACS");
});

test("provider evidence renews the 15-day hazard lifecycle", () => {
  const source = fs.readFileSync(path.join(projectRoot, "automation.js"), "utf8");
  assert.match(source, /HAZARD_RETENTION_MS = 15 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /feature\.properties\.lastSeenAt = checkedAt/);
  assert.doesNotMatch(source, /reconcileProviderSnapshot\("nasa_eonet"/);
});

test("GDACS retains active feed events for the lifecycle and labels wildfire dates accurately", () => {
  const source = fs.readFileSync(path.join(projectRoot, "automation.js"), "utf8");
  assert.match(source, /gdacs\\\\:iscurrent/);
  assert.match(source, /gdacs\\\\:todate/);
  assert.match(source, /gdacs\\\\:alertlevel/);
  assert.match(source, /if \(!providerActive\) continue/);
  assert.match(source, /Last satellite detection:/);
  assert.doesNotMatch(source, /currentGdacsIds/);
});

test("USGS uses a rolling 15-day query and removes microearthquakes", () => {
  const source = fs.readFileSync(path.join(projectRoot, "automation.js"), "utf8");
  assert.match(source, /DEFAULT_USGS_MIN_MAGNITUDE/);
  assert.match(source, /minmagnitude: String\(minimumMagnitude\)/);
  assert.match(source, /starttime: startTime/);
  assert.match(source, /reconcileProviderSnapshot\("usgs", usgsFeatures\)/);
  assert.doesNotMatch(source, /summary\/all_day\.geojson/);
});

test("operators can run one immediate refresh without changing the fixed schedule", () => {
  const source = fs.readFileSync(path.join(projectRoot, "automation.js"), "utf8");
  assert.match(source, /process\.argv\.includes\("--refresh-once"\)/);
  assert.match(source, /await refreshAutomatedHazards\(\)/);
  assert.match(source, /scheduleNextHazardRefresh\(\)/);
});

test("large provider refreshes use indexed external ID lookups", () => {
  const source = fs.readFileSync(path.join(projectRoot, "automation.js"), "utf8");
  assert.match(source, /const externalIdIndex = new Map\(\)/);
  assert.match(source, /externalIdIndex\.get\(externalIdKey\)/);
  assert.doesNotMatch(source, /hazards\.features\.findIndex/);
});

test("raw FIRMS thermal pixels are opt-in and old public markers are removed", () => {
  const source = fs.readFileSync(path.join(projectRoot, "automation.js"), "utf8");
  assert.match(source, /FIRMS_PUBLIC_HOTSPOTS/);
  assert.match(source, /function removeDisabledFirmsHotspots\(hazards\)/);
  assert.match(source, /removeDisabledFirmsHotspots\(data\)/);
  assert.match(source, /satellite hotspot cluster/);
  assert.match(source, /EONET supplies public wildfire incidents/);
});

test("Copernicus activations use one event marker instead of AOI coverage polygons", () => {
  const source = fs.readFileSync(path.join(projectRoot, "automation.js"), "utf8");
  assert.match(source, /extId: `ems_\$\{e\.code\}`/);
  assert.match(source, /AOI extents describe mapping coverage, not the hazard footprint/);
  assert.doesNotMatch(source, /extId: `ems_aoi_/);
  assert.doesNotMatch(source, /parseWktPolygon/);
});
