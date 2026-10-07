import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performBackup } from "../scripts/backup.js";
import { performRestore } from "../scripts/restore.js";

function createRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alertly-backup-"));
  const dataDir = path.join(root, "data");
  const backupDir = path.join(root, "backups");
  const reportsFile = path.join(dataDir, "reports.json");
  const hazardsFile = path.join(root, "hazards.geojson");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(reportsFile, JSON.stringify([{ id: "original-report" }]));
  fs.writeFileSync(hazardsFile, JSON.stringify({ type: "FeatureCollection", features: [{ id: "original-hazard" }] }));
  return { root, dataDir, backupDir, reportsFile, hazardsFile };
}

test("backup and restore honor deployment storage paths", () => {
  const runtime = createRuntime();
  try {
    const backupPath = performBackup(runtime);
    assert.equal(path.dirname(backupPath), runtime.backupDir);

    fs.writeFileSync(runtime.reportsFile, "[]");
    fs.writeFileSync(runtime.hazardsFile, JSON.stringify({ type: "FeatureCollection", features: [] }));
    const result = performRestore(backupPath, runtime);

    assert.deepEqual(result, { success: true, reports: 1, hazards: 1 });
    assert.equal(JSON.parse(fs.readFileSync(runtime.reportsFile, "utf8"))[0].id, "original-report");
    assert.equal(JSON.parse(fs.readFileSync(runtime.hazardsFile, "utf8")).features[0].id, "original-hazard");
  } finally {
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
});

test("restore rejects malformed hazard backups without replacing live data", () => {
  const runtime = createRuntime();
  try {
    const invalidBackup = path.join(runtime.root, "invalid.json");
    fs.writeFileSync(invalidBackup, JSON.stringify({ reports: [], hazards: {} }));
    assert.throws(() => performRestore(invalidBackup, runtime), /hazard FeatureCollection/);
    assert.equal(JSON.parse(fs.readFileSync(runtime.reportsFile, "utf8"))[0].id, "original-report");
  } finally {
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
});

test("backup refuses corrupt live data instead of creating an empty snapshot", () => {
  const runtime = createRuntime();
  try {
    fs.writeFileSync(runtime.reportsFile, "{not-json");
    assert.throws(() => performBackup(runtime), /Cannot back up invalid JSON/);
    assert.equal(fs.existsSync(runtime.backupDir), true);
    assert.deepEqual(fs.readdirSync(runtime.backupDir), []);
  } finally {
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
});
