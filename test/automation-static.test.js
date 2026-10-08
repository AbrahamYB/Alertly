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
  assert.doesNotMatch(source, /seenExtIds/, "one missing provider response must not remove a hazard before its lifecycle expires");
});
