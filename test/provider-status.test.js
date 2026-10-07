import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProviderStatus } from "../lib/provider-status.js";

function withProviderEnvironment(callback) {
  const previous = {
    ENABLE_AUTOMATION: process.env.ENABLE_AUTOMATION,
    FIRMS_MAP_KEY: process.env.FIRMS_MAP_KEY,
    PROVIDER_STALE_HOURS: process.env.PROVIDER_STALE_HOURS,
  };
  process.env.ENABLE_AUTOMATION = "true";
  delete process.env.FIRMS_MAP_KEY;
  process.env.PROVIDER_STALE_HOURS = "13";
  try { return callback(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("provider health includes every connected hazard source", () => withProviderEnvironment(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alertly-provider-"));
  const metadataFile = path.join(directory, "hazards.json");
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(metadataFile, JSON.stringify({
    providerStatus: {
      usgs: { status: "healthy", lastSuccessAt: recent },
      nasa_eonet: { status: "healthy", lastSuccessAt: recent },
      gdacs: { status: "healthy", lastSuccessAt: recent },
      rsoe_edis: { status: "healthy", lastSuccessAt: recent },
      copernicus: { status: "healthy", lastSuccessAt: recent },
    },
  }));
  try {
    const result = readProviderStatus(metadataFile);
    assert.deepEqual(result.providers.map(provider => provider.name), [
      "USGS Earthquakes", "NASA EONET", "GDACS", "RSOE EDIS", "Copernicus EMS", "NASA FIRMS"
    ]);
    assert.equal(result.providers.find(provider => provider.name === "RSOE EDIS").status, "healthy");
    assert.equal(result.providers.find(provider => provider.name === "NASA FIRMS").status, "disabled");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}));

test("provider health uses a schedule-compatible stale window", () => withProviderEnvironment(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alertly-provider-stale-"));
  const metadataFile = path.join(directory, "hazards.json");
  const stale = new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(metadataFile, JSON.stringify({ providerStatus: { usgs: { status: "healthy", lastSuccessAt: stale } } }));
  try {
    const result = readProviderStatus(metadataFile);
    assert.equal(result.providers.find(provider => provider.name === "USGS Earthquakes").status, "delayed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}));
