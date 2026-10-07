import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const HAZARDS_FILE = path.join(ROOT_DIR, "hazards.geojson");
const BACKUP_DIR = path.join(ROOT_DIR, "backups");

fs.mkdirSync(BACKUP_DIR, { recursive: true });

function readJsonSafe(filepath, defaultValue) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, "utf8"));
    }
  } catch (err) {
    console.warn(`[BACKUP] Warning reading ${filepath}: ${err.message}`);
  }
  return defaultValue;
}

export function performBackup() {
  const reports = readJsonSafe(REPORTS_FILE, []);
  const hazards = readJsonSafe(HAZARDS_FILE, { type: "FeatureCollection", features: [] });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `backup_${timestamp}.json`;
  const targetPath = path.join(BACKUP_DIR, filename);

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

  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2));
  console.log(`[BACKUP] Backup created successfully: ${filename}`);
  console.log(`[BACKUP] Reports: ${payload.stats.reportsCount} | Hazards: ${payload.stats.hazardsCount}`);
  return targetPath;
}

// If invoked directly from CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  performBackup();
}
