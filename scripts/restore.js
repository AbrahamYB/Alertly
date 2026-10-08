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

export function performRestore(specificFile, options = {}) {
  const { dataDir, reportsFile, hazardsFile, backupDir } = resolvePaths(options);
  let backupPath = specificFile;

  if (!backupPath) {
    if (!fs.existsSync(backupDir)) {
      throw new Error("No backups directory found.");
    }
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith("backup_") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (!files.length) {
      throw new Error("No backup files found in backups directory.");
    }
    backupPath = path.join(backupDir, files[0]);
  }

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  const raw = fs.readFileSync(backupPath, "utf8");
  const data = JSON.parse(raw);

  if (!Array.isArray(data.reports) || data.hazards?.type !== "FeatureCollection" || !Array.isArray(data.hazards.features)) {
    throw new Error("Invalid backup format: expected a reports array and hazard FeatureCollection.");
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(hazardsFile), { recursive: true });

  const tmpReports = `${reportsFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmpReports, JSON.stringify(data.reports, null, 2) + "\n");
  replaceFileSync(tmpReports, reportsFile);

  const tmpHazards = `${hazardsFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmpHazards, JSON.stringify(data.hazards, null, 2) + "\n");
  replaceFileSync(tmpHazards, hazardsFile);

  console.log(`[RESTORE] Successfully restored from: ${path.basename(backupPath)}`);
  console.log(`[RESTORE] Restored ${data.reports.length} reports and ${data.hazards.features?.length || 0} hazards.`);
  return { success: true, reports: data.reports.length, hazards: data.hazards.features?.length || 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targetFile = process.argv[2];
  try {
    performRestore(targetFile);
  } catch (err) {
    console.error(`[RESTORE ERROR] ${err.message}`);
    process.exit(1);
  }
}
