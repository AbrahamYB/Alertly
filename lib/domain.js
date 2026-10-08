import crypto from "crypto";

const VALID_GEOMETRIES = new Set(["Point", "LineString", "Polygon", "MultiPolygon"]);
const VALID_CONFIDENCE = new Set(["confirmed", "probable", "possible", "unverified"]);
const VALID_STATUS = new Set(["active", "monitoring", "resolved"]);
export const HAZARD_PUBLIC_LIFETIME_MS = 15 * 24 * 60 * 60 * 1000;

function isoDate(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function cleanType(value) {
  const normalized = String(value || "other")
    .replace(/[^a-z\s_-]/gi, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-") || "other";
  if (/(wildfire|forest-fire|fire|thermal|burn)/.test(normalized)) return "fire";
  if (/storm-surge/.test(normalized)) return "flood";
  if (/(storm|cyclone|hurricane|typhoon|tornado|lightning|thunder|windstorm|heavy-rain)/.test(normalized)) return "storm";
  if (/(drought|water-scarcity|arid|dry-spell)/.test(normalized)) return "drought";
  if (/(flood|inundation|storm-surge|overflow)/.test(normalized)) return "flood";
  if (/(volcan|lava|eruption|volcanic-ash)/.test(normalized)) return "volcano";
  if (/(landslide|mudslide|debris-flow|rockfall)/.test(normalized)) return "landslide";
  if (/(earthquake|seismic|tremor|quake)/.test(normalized)) return "earthquake";
  if (/(heatwave|heat-wave|extreme-heat|high-temperature)/.test(normalized)) return "heatwave";
  return normalized;
}

export function normalizeHazard(feature, now = new Date()) {
  if (!feature || feature.type !== "Feature" || !VALID_GEOMETRIES.has(feature.geometry?.type)) {
    throw new TypeError("A hazard must be a GeoJSON Feature with point, line, or polygon geometry.");
  }

  const p = feature.properties || {};
  const detectedAt = isoDate(p.detectedAt || p.eventDate || p.createdAt, now.toISOString());
  const source = String(p.source || (p.automated ? "external" : "admin"));
  const sourceEventId = String(p.sourceEventId || p.extId || p.gdacsId || "");
  const rawTitle = String(p.title || p.notes || `${cleanType(p.hazard || p.type)} alert`);
  const clearTitle = source === "nasa" ? rawTitle.replace(/Satellite Thermal Hotspot/gi, "Satellite heat detection") : rawTitle;
  const rawDescription = String(p.description || p.notes || "");
  const clearDescription = source === "nasa" ? rawDescription.replace(/Satellite Thermal Hotspot/gi, "Satellite heat detection") : rawDescription;

  return {
    ...feature,
    id: String(feature.id || p.id || sourceEventId || `haz_${crypto.randomUUID()}`),
    properties: {
      ...p,
      hazard: cleanType(p.hazard || p.type),
      title: clearTitle.slice(0, 180),
      severity: String(p.severity || "unknown").toLowerCase(),
      confidence: VALID_CONFIDENCE.has(String(p.confidence).toLowerCase())
        ? String(p.confidence).toLowerCase()
        : (p.verified ? "confirmed" : p.automated ? "probable" : "unverified"),
      status: VALID_STATUS.has(String(p.status).toLowerCase()) ? String(p.status).toLowerCase() : "active",
      detectedAt,
      lastUpdatedAt: isoDate(p.lastUpdatedAt, detectedAt),
      expiresAt: isoDate(p.expiresAt),
      source,
      sourceType: String(p.sourceType || (source === "community" ? "community reported" : source === "nasa" ? "satellite detection" : p.automated ? "official / external provider" : "admin verified")),
      sourceUrl: String(p.sourceUrl || ""),
      sourceEventId,
      description: clearDescription,
      instructions: String(p.instructions || ""),
      locationEstimated: Boolean(p.locationEstimated),
    },
  };
}

export function hazardActivityTimestamp(feature) {
  const properties = feature?.properties || {};
  for (const value of [
    properties.lastSeenAt,
    properties.lastUpdatedAt,
    properties.detectedAt,
    properties.eventDate,
    properties.createdAt,
  ]) {
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return NaN;
}

export function isHazardCurrent(feature, now = Date.now(), lifetimeMs = HAZARD_PUBLIC_LIFETIME_MS) {
  const activityAt = hazardActivityTimestamp(feature);
  return !Number.isFinite(activityAt) || now - activityAt < lifetimeMs;
}

export function isDeprecatedHazardFeature(feature) {
  const properties = feature?.properties || {};
  const source = String(properties.source || "").toLowerCase();
  const sourceEventId = String(properties.sourceEventId || properties.extId || "").toLowerCase();
  return source === "copernicus" && sourceEventId.startsWith("ems_aoi_");
}

export function compactHazardForPublic(feature) {
  const properties = feature?.properties || {};
  const evidenceSources = [...new Set([
    ...(Array.isArray(properties.evidenceSources) ? properties.evidenceSources : []),
    ...(Array.isArray(properties.supportingEvidence)
      ? properties.supportingEvidence.map((item) => item?.source)
      : []),
  ].map(String).filter(Boolean))];
  const publicProperties = {
    hazard: properties.hazard,
    title: properties.title,
    description: properties.description || properties.notes || "",
    severity: properties.severity,
    confidence: properties.confidence,
    sourceType: properties.sourceType,
    sourceUrl: properties.sourceUrl,
  };
  for (const key of ["communityReport", "reportId", "locationEstimated"]) {
    if (properties[key] !== undefined) publicProperties[key] = properties[key];
  }
  if (evidenceSources.length) publicProperties.evidenceSources = evidenceSources;
  return {
    type: "Feature",
    id: feature.id,
    geometry: feature.geometry,
    properties: publicProperties,
  };
}

export function normalizeReport(input, now = new Date()) {
  const { aiModeration: _legacyAiModeration, ...cleanInput } = input;
  const geometry = input.geometry || {
    type: "Point",
    coordinates: [Number(input.lng), Number(input.lat)],
  };

  if (!["Point", "LineString", "Polygon"].includes(geometry?.type)) {
    throw new TypeError("Report geometry must be a point, line, or polygon.");
  }
  if (geometry.type === "LineString" && (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2)) {
    throw new TypeError("A line report requires at least two points.");
  }
  if (geometry.type === "Polygon" && (!Array.isArray(geometry.coordinates?.[0]) || geometry.coordinates[0].length < 4)) {
    throw new TypeError("An area report requires at least three points and a closed ring.");
  }
  if (geometry.type === "Polygon") {
    const ring = geometry.coordinates[0];
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first?.[0] !== last?.[0] || first?.[1] !== last?.[1]) {
      throw new TypeError("An area report requires a closed ring.");
    }
  }
  if (geometry.type === "Point" && (!Number.isFinite(geometry.coordinates?.[0]) || !Number.isFinite(geometry.coordinates?.[1]))) {
    throw new TypeError("A point report requires valid latitude and longitude.");
  }

  const representativeCoordinates = geometry.type === "Point"
    ? geometry.coordinates
    : geometry.type === "LineString"
      ? geometry.coordinates
      : geometry.type === "Polygon"
        ? geometry.coordinates?.[0]
        : geometry.coordinates?.[0]?.[0];
  if (!Array.isArray(representativeCoordinates) || representativeCoordinates.length === 0) {
    throw new TypeError("Report geometry requires coordinates.");
  }
  const points = geometry.type === "Point" ? [representativeCoordinates] : representativeCoordinates;
  const validPoints = points.filter((point) => Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]));
  if (!validPoints.length || validPoints.length !== points.length) throw new TypeError("Report geometry requires valid coordinates.");
  const center = validPoints.reduce((total, point) => [total[0] + point[0], total[1] + point[1]], [0, 0])
    .map((total) => total / validPoints.length);

  const detectedAt = isoDate(input.detectedAt || input.createdAt, now.toISOString());
  return {
    ...cleanInput,
    id: String(input.id || `rep_${crypto.randomUUID()}`),
    type: String(input.type || "Other"),
    text: String(input.text || "").trim(),
    geometry,
    lat: center[1],
    lng: center[0],
    severity: String(input.severity || "unknown").toLowerCase(),
    status: VALID_STATUS.has(String(input.status).toLowerCase()) ? String(input.status).toLowerCase() : "active",
    moderationStatus: String(input.moderationStatus || (input.isRemoved ? "rejected" : input.verified ? "approved" : "pending")).toLowerCase(),
    createdAt: new Date(detectedAt).getTime(),
    detectedAt,
    updatedAt: isoDate(input.updatedAt, detectedAt),
    aiEvaluation: input.aiEvaluation ? {
      verdict: String(input.aiEvaluation.verdict || "unverified"),
      confidence: Number.isFinite(Number(input.aiEvaluation.confidence)) ? Number(input.aiEvaluation.confidence) : 0,
      reason: [input.aiEvaluation.reason, input.aiEvaluation.visualEvidence]
        .filter(Boolean)
        .map(String)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(" ")
        .slice(0, 500),
    } : null,
  };
}

export function applyReportAiEvaluation(report, aiEvaluation, now = new Date()) {
  const verdict = String(aiEvaluation?.verdict || "unverified").toLowerCase();
  const at = now.toISOString();
  const updated = {
    ...report,
    aiEvaluation,
    publiclyVisible: verdict === "plausible",
    moderationStatus: verdict === "plausible" ? "approved" : "pending",
    verified: verdict === "plausible",
    isRemoved: false,
    updatedAt: at,
  };
  if (verdict !== "nsfw") return updated;
  return {
    ...updated,
    isRemoved: true,
    moderationStatus: "rejected",
    verified: false,
    updatedAt: at,
    auditLog: [
      ...(Array.isArray(report.auditLog) ? report.auditLog : []),
      { id: crypto.randomUUID(), action: "ai-nsfw-quarantine", note: String(aiEvaluation.reason || "Explicit media detected."), at, actor: "AI safety" },
    ],
  };
}

export function isReportPublic(report) {
  if (!report || report.isRemoved || String(report.moderationStatus || "pending").toLowerCase() === "rejected") return false;
  if (String(report.moderationStatus || "").toLowerCase() === "approved" || report.verified === true) return true;
  if (typeof report.publiclyVisible === "boolean") return report.publiclyVisible;
  return String(report.aiEvaluation?.verdict || "").toLowerCase() === "plausible";
}

export function reconcileReportVisibility(report) {
  const moderationStatus = String(report?.moderationStatus || "pending").toLowerCase();
  if (report?.isRemoved || moderationStatus === "rejected") {
    return { ...report, publiclyVisible: false, verified: false };
  }
  if (moderationStatus === "approved" || report?.verified === true) {
    return { ...report, moderationStatus: "approved", publiclyVisible: true, verified: true };
  }
  if (report?.publiclyVisible === false) return { ...report, verified: false };
  if (String(report?.aiEvaluation?.verdict || "").toLowerCase() === "plausible") {
    return { ...report, moderationStatus: "approved", publiclyVisible: true, verified: true };
  }
  return { ...report, publiclyVisible: false, verified: false };
}

export function sanitizeReportForPublic(report) {
  if (!report || typeof report !== "object") return report;
  const normalized = normalizeReport(report);
  const {
    auditLog,
    removalRequests,
    moderatorNotes,
    submitterIp,
    internalNotes,
    ...publicReport
  } = normalized;

  if (Array.isArray(publicReport.images)) {
    publicReport.images = publicReport.images.map((img) => {
      const media = typeof img === "string" ? { url: img } : img || {};
      return {
        url: media.url,
        name: media.name || "Attachment",
        type: media.type || "image",
        size: media.size,
      };
    }).filter(media => typeof media.url === "string" && media.url);
  }

  publicReport.hasRemovalRequest = Boolean(
    normalized.removalRequested ||
    (Array.isArray(normalized.removalRequests) && normalized.removalRequests.some((r) => r.status === "pending"))
  );

  return publicReport;
}

export function normalizeCollection(collection) {
  const features = Array.isArray(collection?.features) ? collection.features : [];
  return {
    type: "FeatureCollection",
    features: features.flatMap((feature) => {
      try { return [normalizeHazard(feature)]; } catch { return []; }
    }),
  };
}
