import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import fs from "fs";
import { featureInHazardRegion, getHazardBbox } from "./lib/hazard-region.js";
import { nextScheduledTime, parseDailyTimes } from "./lib/fixed-schedule.js";
import { replaceFileSync } from "./lib/file-utils.js";
import { isDeprecatedHazardFeature, isHazardCurrent } from "./lib/domain.js";
import { DEFAULT_USGS_MIN_MAGNITUDE, isPublicEarthquake } from "./lib/earthquake-policy.js";
import { resolveCopernicusEventLocation } from "./lib/hazard-location.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HAZARDS_FILE = process.env.HAZARDS_FILE
  ? path.resolve(process.env.HAZARDS_FILE)
  : path.join(__dirname, "hazards.geojson");
const HAZARD_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
const FIRMS_PUBLIC_HOTSPOTS = /^(1|true|yes|on)$/i.test(String(process.env.FIRMS_PUBLIC_HOTSPOTS || ""));

// Full-world monitoring bounds. Override with HAZARD_BBOX=minLng,minLat,maxLng,maxLat.
const BBOX = getHazardBbox();

async function fetchOfficial(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: { Accept: "application/json, application/geo+json, application/xml, text/xml, text/csv", "User-Agent": "Alertly/1.0", ...options.headers },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

function timestampOf(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1e11) return numeric;
  return new Date(value).getTime();
}

function isoTimestamp(value, fallback = Date.now()) {
  const timestamp = timestampOf(value);
  return new Date(Number.isFinite(timestamp) ? timestamp : fallback).toISOString();
}

function isRecentProviderFeature(feature, now = Date.now()) {
  if (!feature?.properties?.automated) return true;
  return isHazardCurrent(feature, now, HAZARD_RETENTION_MS);
}

function isFirmsHotspotFeature(feature) {
  const properties = feature?.properties || {};
  const externalId = String(properties.extId || "");
  return properties.source === "nasa"
    && (["satellite detection", "satellite hotspot cluster"].includes(properties.sourceType)
      || /^nasa_(?:firms_)?/.test(externalId));
}

function removeDisabledFirmsHotspots(hazards) {
  if (FIRMS_PUBLIC_HOTSPOTS || !Array.isArray(hazards?.features)) return 0;
  const previousCount = hazards.features.length;
  hazards.features = hazards.features.filter(feature => !isFirmsHotspotFeature(feature));
  return previousCount - hazards.features.length;
}

function getHazards() {
  try {
    const raw = fs.readFileSync(HAZARDS_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return { type: "FeatureCollection", features: [] };
  }
}

function saveHazards(data) {
  const tmpPath = `${HAZARDS_FILE}.${process.pid}.tmp`;
  try {
    removeDisabledFirmsHotspots(data);
    // Keep collection-level sync metadata for the status API.
    data.lastUpdated = new Date().toISOString();
    data.status = "Monitoring";

    fs.mkdirSync(path.dirname(HAZARDS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    replaceFileSync(tmpPath, HAZARDS_FILE);
  } catch (e) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    console.error("Failed to save hazards:", e);
    throw e;
  }
}

function saveHazardMetadata(patch) {
  const tmpPath = `${HAZARDS_FILE}.${process.pid}.tmp`;
  try {
    const hazards = getHazards();
    const removedCount = removeDisabledFirmsHotspots(hazards);
    if (removedCount > 0) {
      console.log(`[Automation] Removed ${removedCount} legacy FIRMS hotspot marker${removedCount === 1 ? "" : "s"}; EONET supplies public wildfire incidents.`);
    }
    Object.assign(hazards, patch);
    fs.mkdirSync(path.dirname(HAZARDS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(hazards, null, 2));
    replaceFileSync(tmpPath, HAZARDS_FILE);
  } catch (e) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    console.error("Metadata save failed:", e);
  }
}

function formatDateString(str) {
  if (!str) return "";
  return str.replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g, (match, d, m, y) => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months[parseInt(m, 10) - 1];
    if (!month) return match;
    return `${month} ${parseInt(d, 10)}, ${y}`;
  });
}

let isRefreshing = false;

async function fetchUSGSEarthquakes() {
  const configuredMinimum = Number(process.env.USGS_MIN_MAGNITUDE);
  const minimumMagnitude = Number.isFinite(configuredMinimum) && configuredMinimum >= 0
    ? configuredMinimum
    : DEFAULT_USGS_MIN_MAGNITUDE;
  const startTime = new Date(Date.now() - HAZARD_RETENTION_MS).toISOString();
  const params = new URLSearchParams({
    format: "geojson",
    starttime: startTime,
    minmagnitude: String(minimumMagnitude),
    orderby: "time-asc",
    limit: "20000",
  });
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?${params}`;
  try {
    const resp = await fetchOfficial(url);
    const data = await resp.json();
    return (data.features || []).filter(f => {
      const [lng, lat] = f.geometry.coordinates;
      return isPublicEarthquake(f.properties, minimumMagnitude)
        && lng >= BBOX[0] && lng <= BBOX[2] && lat >= BBOX[1] && lat <= BBOX[3];
    }).map(f => ({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        hazard: "earthquake",
        severity: f.properties.mag >= 5 ? "high" : f.properties.mag >= 3.5 ? "medium" : "low",
        title: f.properties.title || `M ${f.properties.mag} - ${f.properties.place}`,
        confidence: f.properties.status === "reviewed" ? "confirmed" : "probable",
        notes: `Depth: ${f.geometry.coordinates[2]} km. ${f.properties.felt ? `${f.properties.felt} felt report(s).` : ""}`.trim(),
        automated: true,
        source: "usgs",
        sourceType: "official seismic feed",
        sourceUrl: f.properties.url,
        extId: `usgs_${f.id}`,
        detectedAt: new Date(f.properties.time).toISOString(),
        lastUpdatedAt: new Date(f.properties.updated || f.properties.time).toISOString(),
        createdAt: new Date(f.properties.time).toISOString()
      }
    }));
  } catch (e) {
    console.error("[Automation] USGS Fetch failed:", e.message);
    return null;
  }
}

// NASA FIRMS VIIRS active fires from the last 24 hours.
async function fetchNASAFires() {
  const apiKey = process.env.FIRMS_MAP_KEY;
  const sources = String(process.env.FIRMS_SOURCES || "VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT")
    .split(",").map(value => value.trim()).filter(Boolean);
  const dayRange = Math.min(5, Math.max(1, Number(process.env.FIRMS_DAY_RANGE || 1)));
  if (!apiKey) {
    console.warn("[Automation] NASA FIRMS disabled: FIRMS_MAP_KEY is not set.");
    return null;
  }

  try {
    const results = await Promise.all(sources.map(async sourceId => {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${apiKey}/${sourceId}/${BBOX[0]},${BBOX[1]},${BBOX[2]},${BBOX[3]}/${dayRange}`;
      const response = await fetchOfficial(url, { headers: { Accept: "text/csv" } });
      const lines = (await response.text()).trim().split("\n");
      if (lines.length <= 1) return [];
      const headers = lines[0].split(",").map(value => value.trim());
      return lines.slice(1).map(row => {
        const values = row.split(",").map(value => value.trim());
        return headers.reduce((record, header, index) => ({ ...record, [header]: values[index] }), { sourceId });
      });
    }));
    const data = results.flat();
    console.log(`[Automation] NASA FIRMS VIIRS found ${data.length} detections from ${sources.join(", ")}.`);
    return data.slice(0, 6000).map(detection => {
      const temperature = detection.bright_ti4 || detection.brightness || "N/A";
      const confidence = String(detection.confidence || "").toLowerCase();
      const severity = confidence === "h" || Number(confidence) > 80 ? "high" : confidence === "l" ? "low" : "medium";
      const acquiredDate = detection.acq_date
        ? new Date(`${detection.acq_date}T${String(detection.acq_time || "0000").padStart(4, "0").replace(/(..)(..)/, "$1:$2")}:00Z`)
        : new Date();
      const acquiredAt = Number.isNaN(acquiredDate.getTime()) ? new Date().toISOString() : acquiredDate.toISOString();
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [Number(detection.longitude), Number(detection.latitude)] },
        properties: {
          hazard: "fire",
          title: "Satellite heat detection",
          severity,
          confidence: "probable",
          notes: `VIIRS satellite heat detection (${detection.satellite || detection.sourceId}/${detection.instrument || "VIIRS"}): ${temperature}K; sensor confidence ${detection.confidence || "unknown"}.`,
          automated: true,
          source: "nasa",
          sourceType: "satellite detection",
          sourceUrl: "https://firms.modaps.eosdis.nasa.gov/",
          extId: `nasa_${detection.sourceId}_${detection.satellite}_${detection.acq_date}_${detection.acq_time}_${detection.latitude}_${detection.longitude}`,
          detectedAt: acquiredAt,
          lastUpdatedAt: acquiredAt,
        }
      };
    }).filter(feature => feature.geometry.coordinates.every(Number.isFinite));
  } catch (e) {
    console.error("[Automation] NASA FIRMS failed:", e.message);
    return null;
  }
}

// NASA EONET open natural events.
async function fetchNASAEonet() {
  const url = `https://eonet.gsfc.nasa.gov/api/v3/events?bbox=${BBOX[0]},${BBOX[3]},${BBOX[2]},${BBOX[1]}&status=open&limit=500`;
  try {
    const resp = await fetchOfficial(url);
    const data = await resp.json();
    return (data.events || []).map(e => {
      // EONET appends geometries over time; the last entry is the current one.
      const latestGeo = e.geometry[e.geometry.length - 1];
      if (!latestGeo) return null;
      const category = (e.categories?.[0]?.id || "other").toLowerCase();
      
      const categoryMap = {
         "wildfires": "fire",
         "volcanoes": "volcano",
         "severestorms": "storm",
         "floods": "flood",
         "landslides": "landslide",
         "drought": "drought",
         "earthquakes": "earthquake",
         "tempextremes": "heatwave",
         "sealakeice": "other",
         "dusthaze": "other"
      };

      return {
        type: "Feature",
        geometry: latestGeo,
        properties: {
          hazard: categoryMap[category] || "other",
          title: e.title,
          severity: "medium",
          confidence: "probable",
          notes: e.description || "Open natural event tracked by NASA EONET.",
          automated: true,
          source: "nasa_eonet",
          sourceType: "NASA curated event",
          sourceUrl: e.link || e.sources?.[0]?.url || "https://eonet.gsfc.nasa.gov/",
          extId: `eonet_${e.id}`,
          eventDate: latestGeo.date,
          detectedAt: latestGeo.date,
          lastUpdatedAt: latestGeo.date,
          createdAt: latestGeo.date
        }
      };
    }).filter((feature) => feature && featureInHazardRegion(feature, BBOX));
  } catch (e) {
    console.error("[Automation] NASA EONET failed:", e.message);
    return null;
  }
}

// RSOE EDIS emergency events.
async function fetchRSOEEDIS() {
  const url = `https://rsoe-edis.org/gateway/webapi/events/cluster?zoom=3`;
  try {
     const resp = await fetchOfficial(url);
     const data = await resp.json();
     if (!Array.isArray(data.features)) throw new Error("Invalid RSOE response.");

     const catMap = {
       "GE": { "ERQ": "earthquake", "VOL": "volcano" },
       "HY": { "FLD": "flood" },
       "WE": { "STO": "storm", "FL": "flood", "EXR": "flood" }
     };

     return data.features.flatMap(f => {
        const properties = f?.properties || {};
        const cat = properties.category;
        const sub = properties.subCategory;
        const hazard = catMap[cat]?.[sub] || "other";

        const coordinates = f?.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates)
          ? f.geometry.coordinates.map(Number)
          : null;
        if (!f?.geometry || !featureInHazardRegion(f, BBOX)) return [];
        const providerDate = properties.lastUpdate || properties.eventDate;
        const providerTimestamp = timestampOf(providerDate);
        const providerDateIso = isoTimestamp(providerTimestamp);
        const coordinateLabel = coordinates?.every(Number.isFinite)
          ? `${coordinates[1].toFixed(3)}, ${coordinates[0].toFixed(3)}`
          : "reported area";
        const place = properties.centroid || properties.location || coordinateLabel;
        const eventCount = Number(properties.count || properties.aggregated || 1);
        const eventId = properties.id
          ? `${properties.id}_${properties.subId || 0}`
          : `${cat || "event"}_${sub || "other"}_${coordinates?.join("_") || providerDateIso}`;
        const eventTitle = properties.title || `${properties.categoryName || hazard} near ${place}`;

        return [{
           type: "Feature",
           geometry: f.geometry,
           properties: {
              hazard: hazard,
              severity: properties.severity === "high" ? "high" : "medium",
              confidence: "probable",
              title: eventTitle,
              notes: `${eventTitle}. ${properties.details || `${eventCount} nearby event${eventCount === 1 ? "" : "s"}.`} Severity: ${properties.severity || "unknown"}.`,
              automated: true,
              source: "rsoe_edis",
              sourceType: "official disaster feed",
              sourceUrl: properties.link || properties.source || "https://rsoe-edis.org/eventMap",
              extId: `edis_${eventId}`,
              eventDate: providerDateIso,
              detectedAt: providerDateIso,
              lastUpdatedAt: providerDateIso,
              createdAt: providerDateIso
           }
        }];
     });
  } catch (e) {
     console.error("[Automation] RSOE EDIS failed:", e.message);
     return null;
  }
}

// Copernicus EMS rapid-mapping activations and AOI polygons.
async function fetchCopernicusEMS() {
  const listUrl = `https://mapping.emergency.copernicus.eu/activations/api/activations/?limit=50`; 
  try {
     const resp = await fetchOfficial(listUrl);
     const data = await resp.json();
     if (!Array.isArray(data.results)) throw new Error("Invalid Copernicus response.");

     const features = [];
     for (const e of data.results) {
        // Activations expose their centroid as WKT.
        const centroidMatch = e.centroid?.match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
        let coords = [0, 0];
        if (centroidMatch) {
           coords = [parseFloat(centroidMatch[1]), parseFloat(centroidMatch[2])];
        }

        const isBboxMatch = coords[0] >= BBOX[0] && coords[0] <= BBOX[2] && coords[1] >= BBOX[1] && coords[1] <= BBOX[3];
        
        if (!isBboxMatch) continue;

        const categorySlug = String(e.category?.slug || "").toLowerCase();
        const hazard = categorySlug.includes("flood") ? "flood"
          : categorySlug.includes("fire") ? "fire"
          : categorySlug.includes("storm") || categorySlug.includes("cyclone") ? "storm"
          : categorySlug.includes("volcan") ? "volcano"
          : categorySlug.includes("earthquake") ? "earthquake"
          : "other";

        let mappedAreaSummary = "";
        let areaNames = [];
        try {
           const actDetailUrl = `https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?code=${e.code}`;
           const actResp = await fetchOfficial(actDetailUrl);
           if (actResp.ok) {
              const actData = await actResp.json();
              const activationInfo = actData.results?.[0];
              if (activationInfo && activationInfo.aois && activationInfo.aois.length > 0) {
                 areaNames = [...new Set(activationInfo.aois.map((aoi) => String(aoi.name || "").trim()).filter(Boolean))];
                 const areaLabel = areaNames.slice(0, 3).join(", ");
                 mappedAreaSummary = ` Copernicus mapped ${activationInfo.aois.length} area${activationInfo.aois.length === 1 ? "" : "s"}${areaLabel ? ` (${areaLabel})` : ""}.`;
              }
           }
        } catch (aoiErr) {
           console.warn(`[Automation] AOIs fetch skip for ${e.code}:`, aoiErr.message);
        }

        // AOI extents describe mapping coverage, not the hazard footprint. Use one
        // event marker so the map does not imply that the entire AOI is affected.
        if (centroidMatch) {
           const activationAt = isoTimestamp(e.activationTime);
           const location = resolveCopernicusEventLocation({
              hazard,
              title: e.name,
              areaNames,
              providerCoordinates: coords,
           });
           features.push({
              type: "Feature",
              geometry: { type: "Point", coordinates: location.coordinates },
              properties: {
                 hazard: hazard,
                 severity: "high",
                 confidence: "confirmed",
                 title: e.name || `Copernicus EMS activation ${e.code}`,
                 notes: `Copernicus EMS activation: ${e.name} (${e.code}).${mappedAreaSummary} Location: ${location.source}.`,
                 automated: true,
                 source: "copernicus",
                 sourceType: "official emergency mapping activation",
                 sourceUrl: `https://mapping.emergency.copernicus.eu/activations/${e.code}/`,
                 extId: `ems_${e.code}`,
                 locationEstimated: location.estimated,
                 detectedAt: activationAt,
                 lastUpdatedAt: activationAt,
                 createdAt: activationAt
              }
           });
        }
     }
     return features;
  } catch (e) {
    console.error("[Automation] Copernicus Surge failed:", e.message);
    return null;
  }
}

async function refreshAutomatedHazards() {
  if (isRefreshing) {
    console.log("[Automation] Refresh already in progress, skipping...");
    return;
  }
  const cycleStartedAt = new Date().toISOString();
  let providerStatus = getHazards().providerStatus || {};
  saveHazardMetadata({
    lastHazardCheckAt: cycleStartedAt,
    lastHazardCheckStartedAt: cycleStartedAt,
    lastHazardCheckStatus: "running"
  });
  let cycleFailed = false;
  try {
    isRefreshing = true;
    console.log("[Automation] Starting background hazard refresh...");

    const hazards = getHazards();
    const externalIdIndex = new Map();
    const rebuildExternalIdIndex = () => {
      externalIdIndex.clear();
      hazards.features.forEach((hazard, index) => {
        const externalId = hazard.properties?.extId;
        if (externalId !== undefined && externalId !== null && externalId !== "") {
          const key = String(externalId);
          if (!externalIdIndex.has(key)) externalIdIndex.set(key, index);
        }
      });
    };
    rebuildExternalIdIndex();
    let addedCount = 0;
    let updatedCount = 0;
    let providerRemovedCount = 0;

    const reconcileProviderSnapshot = (source, features) => {
      if (!Array.isArray(features)) return;
      const currentIds = new Set(features.map(feature => String(feature.properties?.extId || "")).filter(Boolean));
      const previousCount = hazards.features.length;
      hazards.features = hazards.features.filter(feature =>
        feature.properties?.source !== source || currentIds.has(String(feature.properties?.extId || ""))
      );
      providerRemovedCount += previousCount - hazards.features.length;
      rebuildExternalIdIndex();
    };

    const mergeProviderFeatures = (providerId, features) => {
      const checkedAt = new Date().toISOString();
      if (!Array.isArray(features)) {
        cycleFailed = true;
        providerStatus[providerId] = {
          ...(providerStatus[providerId] || {}),
          status: "error",
          lastAttemptAt: checkedAt,
          message: "The provider request failed; previously collected hazards were retained.",
        };
        return;
      }
      providerStatus[providerId] = {
        status: "healthy",
        lastAttemptAt: checkedAt,
        lastSuccessAt: checkedAt,
        itemCount: features.length,
        message: `${features.length} current item${features.length === 1 ? "" : "s"} received.`,
      };
      for (const feature of features) {
        const extId = feature.properties?.extId;
        if (!extId) continue;
        const externalIdKey = String(extId);
        const index = externalIdIndex.get(externalIdKey) ?? -1;
        const existing = index > -1 ? hazards.features[index] : null;
        feature.properties.firstSeenAt = existing?.properties?.firstSeenAt
          || existing?.properties?.detectedAt
          || feature.properties.detectedAt
          || checkedAt;
        feature.properties.lastSeenAt = checkedAt;
        if (index > -1) {
          hazards.features[index] = feature;
          updatedCount += 1;
        } else {
          externalIdIndex.set(externalIdKey, hazards.features.length);
          hazards.features.push(feature);
          addedCount += 1;
        }
      }
    };

    console.log("[Automation] Fetching significant earthquake data...");
    const usgsFeatures = await fetchUSGSEarthquakes();
    reconcileProviderSnapshot("usgs", usgsFeatures);
    mergeProviderFeatures("usgs", usgsFeatures);

    console.log("[Automation] Checking public satellite thermal feed settings...");
    if (FIRMS_PUBLIC_HOTSPOTS && process.env.FIRMS_MAP_KEY) {
      mergeProviderFeatures("nasa_firms", await fetchNASAFires());
    } else {
      providerStatus.nasa_firms = {
        status: "disabled",
        lastAttemptAt: new Date().toISOString(),
        message: FIRMS_PUBLIC_HOTSPOTS
          ? "NASA FIRMS is disabled until FIRMS_MAP_KEY is configured."
          : "Public FIRMS hotspot markers are disabled; NASA EONET supplies curated wildfire incidents.",
      };
    }

    console.log("[Automation] Fetching NASA Observatory events (EONET)...");
    const eonetFeatures = await fetchNASAEonet();
    mergeProviderFeatures("nasa_eonet", eonetFeatures);

    console.log("[Automation] Fetching RSOE EDIS events...");
    mergeProviderFeatures("rsoe_edis", await fetchRSOEEDIS());

    console.log("[Automation] Fetching Copernicus EMS activations...");
    mergeProviderFeatures("copernicus", await fetchCopernicusEMS());

    try {
      const gdacsUrl = "https://www.gdacs.org/xml/rss.xml";
      const resp = await fetchOfficial(gdacsUrl, { headers: { Accept: "application/xml, text/xml" } });
      {
        providerStatus.gdacs = {
          status: "healthy",
          lastAttemptAt: new Date().toISOString(),
          lastSuccessAt: new Date().toISOString(),
          message: "The GDACS feed was refreshed successfully.",
        };
        const xml = await resp.text();
        const $xml = cheerio.load(xml, { xmlMode: true });
        const items = $xml("item").toArray();
        for (const el of items) {
          const title = $xml(el).find("title").text();
          let latStr = $xml(el).find("gdacs\\:lat").text() || $xml(el).find("lat").first().text() || $xml(el).find("geo\\:lat").text();
          let lngStr = $xml(el).find("gdacs\\:long").text() || $xml(el).find("long").first().text() || $xml(el).find("geo\\:long").text();
          const georss = $xml(el).find("georss\\:point").text();
          if ((!latStr || !lngStr) && georss) {
            const parts = georss.trim().split(/\s+/);
            latStr = parts[0]; lngStr = parts[1];
          }
          const lat = parseFloat(latStr);
          const lng = parseFloat(lngStr);

          const gdacsType = $xml(el).find("gdacs\\:eventtype").text()?.toLowerCase() || "";
          const alertLevel = ($xml(el).find("gdacs\\:alertlevel").text() || "green").toLowerCase();
          const severityElement = $xml(el).find("gdacs\\:severity").first();
          const burnedArea = Number(severityElement.attr("value")) || 0;
          const providerActive = $xml(el).find("gdacs\\:iscurrent").text().toLowerCase() !== "false";
          const fromDate = $xml(el).find("gdacs\\:fromdate").text() || "";
          const toDate = $xml(el).find("gdacs\\:todate").text() || "";
          const modifiedDate = $xml(el).find("gdacs\\:datemodified").text() || "";
          const eventid = $xml(el).find("gdacs\\:eventid").text() || "";
          if (title && eventid && !isNaN(lat) && !isNaN(lng) && lng >= BBOX[0] && lng <= BBOX[2] && lat >= BBOX[1] && lat <= BBOX[3]) {
            const extId = `gdacs_${gdacsType}_${eventid}`;
            if (!providerActive) continue;
            const categoryMap = { "eq": "earthquake", "tc": "storm", "fl": "flood", "wf": "fire", "vo": "volcano", "ls": "landslide", "dr": "drought", "hw": "heatwave" };
            const hazardType = categoryMap[gdacsType] || "other";
            const cleanTitle = formatDateString(title.replace(/^(Green|Orange|Red)\s+(notification for\s+)?/i, "").trim());
            const fullDesc = ($xml(el).find("description").text() || "").replace(/^(Green|Orange|Red)\s+/i, "").trim();
            const cleanDesc = formatDateString(fullDesc.replace(/^On\s+[A-Z][a-z]{2}\s+\d{1,2}.*?started.*?(until|to)\s+.*?\./i, "").trim());
            let impactLabel = "Minor";
            if (alertLevel === "orange") impactLabel = "Moderate";
            if (alertLevel === "red") impactLabel = "Significant";
            const gdacsSource = `https://www.gdacs.org/report.aspx?eventid=${eventid}&eventtype=${gdacsType.toUpperCase()}`;
            const geometry = { type: "Point", coordinates: [lng, lat] };
            const deaths = fullDesc.match(/(?:caused|reported)\s+(\d+)\s+deaths?/i)?.[1];
            const displaced = fullDesc.match(/(\d+)\s+displaced/i)?.[1];
            const affected = fullDesc.match(/(\d+)\s+affected/i)?.[1];
            const impacts = [];
            if (deaths !== undefined) impacts.push(Number(deaths) === 0 ? "no deaths reported" : `${deaths} deaths reported`);
            if (displaced !== undefined) impacts.push(`${displaced} people displaced`);
            if (affected !== undefined) impacts.push(`${affected} people affected`);
            const eventDate = Number.isNaN(new Date(fromDate).getTime())
              ? ""
              : new Date(fromDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
            const lastDetectionDate = Number.isNaN(new Date(toDate).getTime())
              ? ""
              : new Date(toDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
            const wildfireDetails = gdacsType === "wf"
              ? [lastDetectionDate ? `Last satellite detection: ${lastDetectionDate}.` : "", burnedArea ? `Estimated burned area: ${Math.round(burnedArea).toLocaleString("en-US")} ha.` : ""]
              : [];
            const summary = [`${impactLabel} GDACS alert.`, eventDate ? `Event date: ${eventDate}.` : "", ...wildfireDetails, impacts.length ? `Reported impact: ${impacts.join("; ")}.` : gdacsType === "wf" ? "" : cleanDesc]
              .filter(Boolean).join(" ");

            const checkedAt = new Date().toISOString();
            const feature = {
              type: "Feature",
              properties: {
                hazard: hazardType,
                severity: impactLabel.toLowerCase(),
                title: cleanTitle,
                confidence: "confirmed",
                notes: summary,
                automated: true,
                source: "gdacs",
                sourceType: "official disaster alert",
                sourceUrl: gdacsSource,
                gdacsId: extId,
                extId: extId,
                eventDate: fromDate,
                detectedAt: fromDate || new Date().toISOString(),
                lastDetectionAt: toDate || undefined,
                lastUpdatedAt: modifiedDate || toDate || fromDate || new Date().toISOString(),
                createdAt: fromDate || checkedAt,
                lastSeenAt: checkedAt,
                providerActive: true
              },
              geometry: geometry
            };
            const existingIdx = externalIdIndex.get(extId) ?? -1;
            feature.properties.firstSeenAt = existingIdx > -1
              ? hazards.features[existingIdx].properties.firstSeenAt || hazards.features[existingIdx].properties.detectedAt
              : feature.properties.detectedAt;
            if (existingIdx > -1) { hazards.features[existingIdx] = feature; updatedCount++; }
            else {
              externalIdIndex.set(extId, hazards.features.length);
              hazards.features.push(feature);
              addedCount++;
            }
          }
        }
        providerStatus.gdacs.itemCount = items.length;
        providerStatus.gdacs.message = `${items.length} current feed item${items.length === 1 ? "" : "s"} received.`;
      }
    } catch (e) {
      cycleFailed = true;
      const checkedAt = new Date().toISOString();
      providerStatus.gdacs = {
        ...(providerStatus.gdacs || {}),
        status: "error",
        lastAttemptAt: checkedAt,
        message: `GDACS refresh failed: ${e.message}`,
      };
      console.warn("[Automation] GDACS fetch failed, keeping old data.");
    }

    const initialCount = hazards.features.length;
    hazards.features = hazards.features.filter((feature) =>
      !isDeprecatedHazardFeature(feature) && isRecentProviderFeature(feature)
    );
    const removedCount = providerRemovedCount + initialCount - hazards.features.length;

    if (addedCount > 0 || updatedCount > 0 || removedCount > 0) {
      saveHazards(hazards);
      console.log(`[Automation] Provider sync: ${addedCount} added, ${updatedCount} updated, ${removedCount} removed. Total: ${hazards.features.length}`);
    }

  } catch (err) {
    cycleFailed = true;
    console.error("[Automation] Refresh failed:", err.message);
  } finally {
    const cycleEndedAt = new Date().toISOString();
    saveHazardMetadata({
      lastHazardCheckAt: cycleEndedAt,
      lastHazardCheckCompletedAt: cycleEndedAt,
      lastHazardCheckStatus: cycleFailed ? "failed" : "ok",
      providerStatus,
    });
    isRefreshing = false;
    console.log("[Automation] Cycle complete.");
  }
}
const REFRESH_TIMES = parseDailyTimes(process.env.HAZARD_REFRESH_TIMES || "00:00,12:00");
const REFRESH_TIMEZONE = process.env.HAZARD_REFRESH_TIMEZONE || "America/Guatemala";

function scheduleNextHazardRefresh(from = new Date()) {
  const nextRun = nextScheduledTime(from, { times: REFRESH_TIMES, timeZone: REFRESH_TIMEZONE });
  const delay = Math.max(0, nextRun.getTime() - Date.now());
  saveHazardMetadata({
    nextHazardCheckAt: nextRun.toISOString(),
    hazardCheckSchedule: REFRESH_TIMES,
    hazardCheckTimeZone: REFRESH_TIMEZONE,
  });
  console.log(`[Automation] Next combined provider refresh at ${nextRun.toISOString()} (${REFRESH_TIMES.join(" and ")} ${REFRESH_TIMEZONE}).`);
  setTimeout(async () => {
    await refreshAutomatedHazards();
    scheduleNextHazardRefresh(new Date(Date.now() + 60_000));
  }, delay);
}

if (process.argv.includes("--refresh-once")) {
  await refreshAutomatedHazards();
} else {
  scheduleNextHazardRefresh();
}
