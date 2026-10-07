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

export function performRestore(specificFile) {
  let backupPath = specificFile;

  if (!backupPath) {
    if (!fs.existsSync(BACKUP_DIR)) {
      throw new Error("No backups directory found.");
    }
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("backup_") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (!files.length) {
      throw new Error("No backup files found in backups directory.");
    }
    backupPath = path.join(BACKUP_DIR, files[0]);
  }

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  const raw = fs.readFileSync(backupPath, "utf8");
  const data = JSON.parse(raw);

  if (!Array.isArray(data.reports) || !data.hazards || typeof data.hazards !== "object") {
    throw new Error("Invalid backup format: missing reports array or hazards object.");
  }

  // Atomically write restored files
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tmpReports = REPORTS_FILE + ".tmp";
  fs.writeFileSync(tmpReports, JSON.stringify(data.reports, null, 2) + "\n");
  fs.renameSync(tmpReports, REPORTS_FILE);

  const tmpHazards = HAZARDS_FILE + ".tmp";
  fs.writeFileSync(tmpHazards, JSON.stringify(data.hazards, null, 2) + "\n");
  fs.renameSync(tmpHazards, HAZARDS_FILE);

  console.log(`[RESTORE] Successfully restored from: ${path.basename(backupPath)}`);
  console.log(`[RESTORE] Restored ${data.reports.length} reports and ${data.hazards.features?.length || 0} hazards.`);
  return { success: true, reports: data.reports.length, hazards: data.hazards.features?.length || 0 };
}

// If invoked directly from CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targetFile = process.argv[2];
  try {
    performRestore(targetFile);
  } catch (err) {
    console.error(`[RESTORE ERROR] ${err.message}`);
    process.exit(1);
  }
}
