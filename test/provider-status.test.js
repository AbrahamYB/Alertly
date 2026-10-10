import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProviderStatus } from "../lib/provider-status.js";

function withProviderEnvironment(callback) {
  const previous = {
    ENABLE_AUTOMATION: process.env.ENABLE_AUTOMATION,
    PROVIDER_STALE_HOURS: process.env.PROVIDER_STALE_HOURS,
  };
  process.env.ENABLE_AUTOMATION = "true";
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
      ifrc_go: { status: "healthy", lastSuccessAt: recent },
      fema: { status: "healthy", lastSuccessAt: recent },
      nifc_irwin: { status: "healthy", lastSuccessAt: recent },
      usgs: { status: "supporting-only", lastSuccessAt: recent },
      nasa_eonet: { status: "supporting-only", message: "Not published without impact evidence." },
      gdacs: { status: "supporting-only", lastSuccessAt: recent },
      rsoe_edis: { status: "disabled", message: "Aggregate clusters are not public incidents." },
      copernicus: { status: "healthy", lastSuccessAt: recent },
    },
  }));
  try {
    const result = readProviderStatus(metadataFile);
    assert.deepEqual(result.providers.map(provider => provider.name), [
      "IFRC GO verified emergencies", "FEMA disaster declarations", "NIFC/IRWIN wildfire incidents", "USGS PAGER earthquakes", "NASA EONET", "GDACS modelled alerts", "RSOE EDIS clusters", "Copernicus EMS", "NASA FIRMS hotspots"
    ]);
    assert.equal(result.providers.find(provider => provider.name === "RSOE EDIS clusters").status, "disabled");
    assert.equal(result.providers.find(provider => provider.name === "NASA EONET").status, "supporting-only");
    assert.equal(result.providers.find(provider => provider.name === "NASA FIRMS hotspots").status, "supporting-only");
    assert.equal(result.providers.find(provider => provider.name === "USGS PAGER earthquakes").status, "supporting-only");
    assert.equal(result.providers.find(provider => provider.name === "GDACS modelled alerts").status, "supporting-only");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}));

test("provider health uses a schedule-compatible stale window", () => withProviderEnvironment(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alertly-provider-stale-"));
  const metadataFile = path.join(directory, "hazards.json");
  const stale = new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(metadataFile, JSON.stringify({ providerStatus: { ifrc_go: { status: "healthy", lastSuccessAt: stale } } }));
  try {
    const result = readProviderStatus(metadataFile);
    assert.equal(result.providers.find(provider => provider.name === "IFRC GO verified emergencies").status, "delayed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}));
