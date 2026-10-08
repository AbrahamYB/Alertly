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
  return String(value || "other")
    .replace(/[^a-z\s_-]/gi, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-") || "other";
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
  for (const key of ["communityReport", "reportId", "grouped", "groupedEventCount", "displayCluster"]) {
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

function distanceKm(a, b) {
  const radians = (value) => value * Math.PI / 180;
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const deltaLat = lat2 - lat1;
  const deltaLng = radians(b[0] - a[0]);
  const h = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function groupNearbyPointHazards(collection, radiusKm = 20) {
  const features = Array.isArray(collection?.features) ? collection.features : [];
  const passthrough = features.filter((feature) => feature.geometry?.type !== "Point");
  const byType = new Map();
  for (const feature of features.filter((item) => item.geometry?.type === "Point")) {
    const key = feature.properties?.hazard || "other";
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(feature);
  }

  const output = [];
  const cellDegrees = Math.max(radiusKm / 111.32, 0.01);
  for (const [hazardType, points] of byType) {
    const clusters = [];
    const cells = new Map();
    for (const feature of points) {
      const coordinates = feature.geometry.coordinates;
      const latCell = Math.floor(coordinates[1] / cellDegrees);
      const lngCell = Math.floor(coordinates[0] / cellDegrees);
      const candidates = new Set();
      for (let y = -2; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) {
          for (const index of cells.get(`${latCell + y}:${lngCell + x}`) || []) candidates.add(index);
        }
      }
      let bestIndex = -1;
      let bestDistance = Infinity;
      for (const index of candidates) {
        const distance = distanceKm(coordinates, clusters[index].center);
        if (distance <= radiusKm && distance < bestDistance) {
          bestIndex = index;
          bestDistance = distance;
        }
      }
      if (bestIndex < 0) {
        bestIndex = clusters.length;
        clusters.push({ center: [...coordinates], features: [] });
      }
      const cluster = clusters[bestIndex];
      cluster.features.push(feature);
      cluster.center = cluster.features.reduce((sum, item) => [
        sum[0] + item.geometry.coordinates[0] / cluster.features.length,
        sum[1] + item.geometry.coordinates[1] / cluster.features.length,
      ], [0, 0]);
      const cellKey = `${latCell}:${lngCell}`;
      if (!cells.has(cellKey)) cells.set(cellKey, []);
      cells.get(cellKey).push(bestIndex);
    }

    for (const cluster of clusters) {
      if (cluster.features.length === 1) {
        output.push(cluster.features[0]);
        continue;
      }
      const severityRank = { unknown: 0, minor: 1, low: 2, medium: 3, high: 4, critical: 5 };
      const confidenceRank = { unverified: 0, possible: 1, probable: 2, confirmed: 3 };
      const highest = (items, field, ranks) => items.reduce((best, item) =>
        (ranks[item.properties[field]] ?? 0) > (ranks[best] ?? 0) ? item.properties[field] : best, Object.keys(ranks)[0]);
      const latest = [...cluster.features].sort((a, b) => new Date(b.properties.lastUpdatedAt) - new Date(a.properties.lastUpdatedAt))[0];
      const ids = cluster.features.map((item) => String(item.id)).sort();
      const groupId = `group_${crypto.createHash("sha1").update(ids.join("|")).digest("hex").slice(0, 16)}`;
      const label = hazardType.replace(/(^|-)(\w)/g, (_match, _dash, letter) => ` ${letter.toUpperCase()}`).trim();
      output.push({
        type: "Feature",
        id: groupId,
        geometry: { type: "Point", coordinates: cluster.center },
        properties: {
          ...latest.properties,
          hazard: hazardType,
          title: `${label} — ${cluster.features.length} nearby detections`,
          description: `${cluster.features.length} nearby ${hazardType} point detections were automatically grouped within ${radiusKm} km.`,
          severity: highest(cluster.features, "severity", severityRank),
          confidence: highest(cluster.features, "confidence", confidenceRank),
          source: "alertly-grouping",
          sourceType: "grouped supporting evidence",
          sourceUrl: "",
          sourceEventId: groupId,
          grouped: true,
          groupedEventCount: cluster.features.length,
          groupRadiusKm: radiusKm,
          supportingEvidence: cluster.features.map((item) => ({
            hazardId: item.id,
            title: item.properties.title,
            source: item.properties.source,
            sourceType: item.properties.sourceType,
            sourceUrl: item.properties.sourceUrl,
            sourceEventId: item.properties.sourceEventId,
            coordinates: item.geometry.coordinates,
          })),
        },
      });
    }
  }
  return { ...collection, features: [...passthrough, ...output] };
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
