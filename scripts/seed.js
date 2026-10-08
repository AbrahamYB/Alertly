import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { performBackup } from "./backup.js";
import { replaceFileSync } from "../lib/file-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, "data"));
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const HAZARDS_FILE = path.resolve(process.env.HAZARDS_FILE || path.join(ROOT_DIR, "hazards.geojson"));

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(HAZARDS_FILE), { recursive: true });

console.log("[SEED] 1. Creating backup of current database state...");
performBackup();

console.log("[SEED] 2. Writing demo datasets...");

// Demo community reports across key hazard categories.
const DEMO_REPORTS = [
  {
    id: "rep_demo_fire_tegucigalpa",
    type: "🔥 Fire",
    text: "Brush fire actively spreading uphill towards radio towers on El Picacho ridge. Moderate wind driving smoke toward residential zone.",
    lat: 14.1167,
    lng: -87.1950,
    severity: "high",
    status: "active",
    moderationStatus: "approved",
    verified: true,
    publiclyVisible: true,
    isRemoved: false,
    createdAt: Date.now() - 15 * 60 * 1000,
    detectedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    geometry: {
      type: "Polygon",
      coordinates: [[
        [-87.202, 14.113],
        [-87.188, 14.113],
        [-87.188, 14.122],
        [-87.202, 14.122],
        [-87.202, 14.113]
      ]]
    },
    images: [],
    aiEvaluation: {
      verdict: "plausible",
      confidence: 94,
      reason: "Coordinates correspond to El Picacho ridge north of Tegucigalpa, a known wildfire corridor with matching elevation profile.",
      visualEvidence: null,
      analyzedAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
      model: "groq/compound-mini"
    },
    auditLog: [
      { id: "audit_1", action: "submitted", note: "Citizen mobile submission", at: new Date(Date.now() - 15 * 60 * 1000).toISOString(), actor: "Citizen" },
      { id: "audit_2", action: "approved", note: "Verified through local fire service broadcast", at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), actor: "Moderator" }
    ]
  },
  {
    id: "rep_demo_flood_choluteca",
    type: "🌊 Flood",
    text: "River level breached low-water bridge near Barrio El Centro. Water depth approximately 40cm over roadway. Road currently impassable for passenger vehicles.",
    lat: 13.3025,
    lng: -87.1850,
    severity: "medium",
    status: "active",
    moderationStatus: "approved",
    verified: true,
    publiclyVisible: true,
    isRemoved: false,
    createdAt: Date.now() - 45 * 60 * 1000,
    detectedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    geometry: {
      type: "Polygon",
      coordinates: [[
        [-87.192, 13.298],
        [-87.178, 13.298],
        [-87.178, 13.308],
        [-87.192, 13.308],
        [-87.192, 13.298]
      ]]
    },
    images: [],
    aiEvaluation: {
      verdict: "plausible",
      confidence: 88,
      reason: "Choluteca River basin area. Consistent with regional precipitation patterns.",
      visualEvidence: null,
      analyzedAt: new Date(Date.now() - 44 * 60 * 1000).toISOString(),
      model: "groq/compound-mini"
    },
    auditLog: [
      { id: "audit_3", action: "submitted", note: "Field report", at: new Date(Date.now() - 45 * 60 * 1000).toISOString(), actor: "Citizen" },
      { id: "audit_4", action: "approved", note: "Municipal advisory matches report", at: new Date(Date.now() - 35 * 60 * 1000).toISOString(), actor: "Moderator" }
    ]
  },
  {
    id: "rep_demo_landslide_pending",
    type: "⛰️ Landslide",
    text: "Minor rockfall blocking one lane of CA-5 Northbound at km 32. Heavy vehicles squeezing past on shoulder. Road crews not yet on scene.",
    lat: 14.3200,
    lng: -87.3500,
    severity: "low",
    status: "active",
    moderationStatus: "pending",
    verified: false,
    publiclyVisible: false,
    isRemoved: false,
    createdAt: Date.now() - 5 * 60 * 1000,
    detectedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    geometry: {
      type: "Polygon",
      coordinates: [[
        [-87.355, 14.316],
        [-87.345, 14.316],
        [-87.345, 14.324],
        [-87.355, 14.324],
        [-87.355, 14.316]
      ]]
    },
    images: [],
    aiEvaluation: {
      verdict: "unverified",
      confidence: 0,
      reason: "Awaiting automated or moderator verification.",
      visualEvidence: null,
      analyzedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      model: "groq/compound-mini"
    },
    auditLog: [
      { id: "audit_5", action: "submitted", note: "Public submission via mobile", at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), actor: "Citizen" }
    ]
  }
];

// Demo official and verified hazards.
const DEMO_HAZARDS = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "haz_demo_quake_salvador",
      geometry: {
        type: "Point",
        coordinates: [-89.218, 13.693, 10.0]
      },
      properties: {
        hazard: "earthquake",
        title: "M 4.2 - 14 km SSW of San Salvador, El Salvador",
        severity: "medium",
        confidence: "confirmed",
        status: "active",
        source: "usgs",
        sourceType: "automated",
        sourceUrl: "https://earthquake.usgs.gov/",
        notes: "Depth: 10.0 km. Light shaking reported in southern metropolitan department.",
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        lastUpdatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        groupedEventCount: 1
      }
    },
    {
      type: "Feature",
      id: "haz_demo_thermal_yoro",
      geometry: {
        type: "Point",
        coordinates: [-87.125, 15.138]
      },
      properties: {
        hazard: "fire",
        title: "Satellite Heat Detection: High-confidence thermal anomaly",
        severity: "medium",
        confidence: "probable",
        status: "active",
        source: "firms",
        sourceType: "automated",
        sourceUrl: "https://firms.modaps.eosdis.nasa.gov/",
        notes: "VIIRS NOAA-20 satellite thermal detection (FRP: 12.4 MW).",
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        lastUpdatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        groupedEventCount: 1
      }
    },
    {
      type: "Feature",
      id: "haz_demo_volcano_pacaya",
      geometry: {
        type: "Point",
        coordinates: [-90.601, 14.381]
      },
      properties: {
        hazard: "volcano",
        title: "Pacaya Volcano: Continuous low-level ash & gas emissions",
        severity: "high",
        confidence: "confirmed",
        status: "active",
        source: "gdacs",
        sourceType: "automated",
        sourceUrl: "https://www.gdacs.org/",
        notes: "Yellow aviation alert level. Dispersal toward Southwest valleys.",
        createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
        lastUpdatedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
        groupedEventCount: 1
      }
    }
  ]
};

// Replace both data files only after their temporary files are complete.
const tempReports = `${REPORTS_FILE}.${process.pid}.tmp`;
fs.writeFileSync(tempReports, JSON.stringify(DEMO_REPORTS, null, 2) + "\n");
replaceFileSync(tempReports, REPORTS_FILE);

const tempHazards = `${HAZARDS_FILE}.${process.pid}.tmp`;
fs.writeFileSync(tempHazards, JSON.stringify(DEMO_HAZARDS, null, 2) + "\n");
replaceFileSync(tempHazards, HAZARDS_FILE);

console.log(`[SEED] Successfully seeded database:`);
console.log(`[SEED] - 3 clean community reports (2 approved, 1 pending review in moderation)`);
console.log(`[SEED] - 3 active official regional hazards (earthquake, fire hotspot, volcano)`);
console.log(`[SEED] Ready for live presentations and automated end-to-end testing.`);
