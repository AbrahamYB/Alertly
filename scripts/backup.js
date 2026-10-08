import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { replaceFileSync } from "../lib/file-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
function resolvePaths(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(ROOT_DIR, "data"));
  return {
    dataDir,
    reportsFile: path.resolve(options.reportsFile || path.join(dataDir, "reports.json")),
    hazardsFile: path.resolve(options.hazardsFile || process.env.HAZARDS_FILE || path.join(ROOT_DIR, "hazards.geojson")),
    backupDir: path.resolve(options.backupDir || process.env.BACKUPS_DIR || path.join(ROOT_DIR, "backups")),
  };
}

function readJson(filepath, defaultValue) {
  if (!fs.existsSync(filepath)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot back up invalid JSON in ${filepath}: ${error.message}`);
  }
}

export function performBackup(options = {}) {
  const { reportsFile, hazardsFile, backupDir } = resolvePaths(options);
  fs.mkdirSync(backupDir, { recursive: true });
  const reports = readJson(reportsFile, []);
  const hazards = readJson(hazardsFile, { type: "FeatureCollection", features: [] });
  if (!Array.isArray(reports)) throw new Error("Cannot back up reports: expected a JSON array.");
  if (hazards?.type !== "FeatureCollection" || !Array.isArray(hazards.features)) {
    throw new Error("Cannot back up hazards: expected a GeoJSON FeatureCollection.");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `backup_${timestamp}.json`;
  const targetPath = path.join(backupDir, filename);

  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    stats: {
      reportsCount: Array.isArray(reports) ? reports.length : 0,
      hazardsCount: Array.isArray(hazards.features) ? hazards.features.length : 0,
    },
    reports,
    hazards,
  };

  const tempPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2) + "\n");
  replaceFileSync(tempPath, targetPath);
  console.log(`[BACKUP] Backup created successfully: ${filename}`);
  console.log(`[BACKUP] Reports: ${payload.stats.reportsCount} | Hazards: ${payload.stats.hazardsCount}`);
  return targetPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  performBackup();
}
