import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import fs from "fs";
import { featureInHazardRegion, getHazardBbox } from "./lib/hazard-region.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HAZARDS_FILE = process.env.HAZARDS_FILE
  ? path.resolve(process.env.HAZARDS_FILE)
  : path.join(__dirname, "hazards.geojson");
const HAZARD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

function isRecentProviderFeature(feature, now = Date.now()) {
  if (!feature?.properties?.automated) return true;
  const properties = feature.properties;
  const timestamp = timestampOf(
    properties.lastUpdatedAt || properties.detectedAt || properties.eventDate || properties.createdAt
  );
  return !Number.isFinite(timestamp) || now - timestamp < HAZARD_RETENTION_MS;
}

function recentProviderFeatures(features) {
  return features.filter((feature) => isRecentProviderFeature(feature));
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
  try {
    // Track specific sync metadata in root to show in UI
    data.lastUpdated = new Date().toISOString();
    data.status = "Monitoring";

    const tmpPath = HAZARDS_FILE + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, HAZARDS_FILE);
  } catch (e) {
    console.error("Failed to save hazards:", e);
  }
}

function saveHazardMetadata(patch) {
  try {
    const hazards = getHazards();
    Object.assign(hazards, patch);
    const tmpPath = HAZARDS_FILE + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(hazards, null, 2));
    fs.renameSync(tmpPath, HAZARDS_FILE);
  } catch (e) {
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
process.on("message", msg => { if (msg === "trigger") refreshAutomatedHazards(); });

async function fetchUSGSEarthquakes() {
  const url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";
  try {
    const resp = await fetchOfficial(url);
    const data = await resp.json();
    return (data.features || []).filter(f => {
      const [lng, lat] = f.geometry.coordinates;
      return lng >= BBOX[0] && lng <= BBOX[2] && lat >= BBOX[1] && lat <= BBOX[3];
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
        extId: f.id,
        detectedAt: new Date(f.properties.time).toISOString(),
        lastUpdatedAt: new Date(f.properties.updated || f.properties.time).toISOString(),
        createdAt: new Date(f.properties.time).toISOString()
      }
    }));
  } catch (e) {
    console.error("[Automation] USGS Fetch failed:", e.message);
    return [];
  }
}

/**  NASA FIRMS (VIIRS 24H ACTIVE FIRES) */
async function fetchNASAFires() {
  const apiKey = process.env.FIRMS_MAP_KEY;
  const sources = String(process.env.FIRMS_SOURCES || "VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT")
    .split(",").map(value => value.trim()).filter(Boolean);
  const dayRange = Math.min(5, Math.max(1, Number(process.env.FIRMS_DAY_RANGE || 1)));
  if (!apiKey) {
    console.warn("[Automation] NASA FIRMS disabled: FIRMS_MAP_KEY is not set.");
    return [];
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
    return [];
  }
}

/**  NASA EONET (Earth Observatory Natural Event Tracker)
 * Tracks MAJOR global events: Storms, Volcanoes, Floods, etc.
 */
async function fetchNASAEonet() {
  const url = `https://eonet.gsfc.nasa.gov/api/v3/events?bbox=${BBOX[0]},${BBOX[3]},${BBOX[2]},${BBOX[1]}&status=open&days=30&limit=100`;
  try {
    const resp = await fetchOfficial(url);
    const data = await resp.json();
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    return (data.events || []).map(e => {
      // EONET usually provides the latest geometry point/polygon
      const latestGeo = e.geometry[e.geometry.length - 1];
      const eventTimestamp = new Date(latestGeo?.date || 0).getTime();
      if (!Number.isFinite(eventTimestamp) || eventTimestamp < cutoff) return null;
      const category = (e.categories?.[0]?.id || "other").toLowerCase();
      
      const categoryMap = {
         "wildfires": "fire",
         "volcanoes": "volcano",
         "severe storms": "storm",
         "floods": "flood",
         "sea and lake ice": "other",
         "dust and haze": "other"
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
    return [];
  }
}

/**  RSOE EDIS (Emergency and Disaster Information Service) */
async function fetchRSOEEDIS() {
  const url = `https://rsoe-edis.org/gateway/webapi/events/cluster?zoom=3`;
  try {
     const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
     if (!resp.ok) return [];
     const data = await resp.json();
     if (!data.features) return [];

     const catMap = {
       "GE": { "ERQ": "earthquake", "VOL": "volcano" },
       "HY": { "FLD": "flood" },
       "WE": { "STO": "storm", "FL": "flood", "EXR": "flood" }
     };

     return data.features.map(f => {
        const cat = f.properties.category;
        const sub = f.properties.subCategory;
        const hazard = catMap[cat]?.[sub] || "other";
        
        const coordinates = f.geometry.coordinates;
        const providerDate = f.properties.lastUpdate || f.properties.eventDate;
        const providerTimestamp = timestampOf(providerDate);
        const providerDateIso = new Date(
          Number.isFinite(providerTimestamp) ? providerTimestamp : Date.now()
        ).toISOString();
        const place = f.properties.centroid || f.properties.location || `${coordinates[1].toFixed(3)}, ${coordinates[0].toFixed(3)}`;
        const eventCount = Number(f.properties.count || f.properties.aggregated || 1);
        const eventId = f.properties.id
          ? `${f.properties.id}_${f.properties.subId || 0}`
          : `${cat}_${sub}_${coordinates[0]}_${coordinates[1]}`;
        const eventTitle = f.properties.title || `${f.properties.categoryName || hazard} near ${place}`;

        return {
           type: "Feature",
           geometry: f.geometry,
           properties: {
              hazard: hazard,
              severity: f.properties.severity === "high" ? "high" : "medium",
              notes: `${eventTitle}. ${f.properties.details || `${eventCount} nearby event${eventCount === 1 ? "" : "s"}.`} Severity: ${f.properties.severity || "unknown"}.`,
              automated: true,
              source: "rsoe_edis",
              sourceUrl: f.properties.link || f.properties.source || "https://rsoe-edis.org/eventMap",
              extId: `edis_${eventId}`,
              eventDate: providerDateIso,
              lastUpdatedAt: providerDateIso,
              createdAt: providerDateIso
           }
        };
     }).filter(f => {
        const [lon, lat] = f.geometry.coordinates;
        return lon >= BBOX[0] && lon <= BBOX[2] && lat >= BBOX[1] && lat <= BBOX[3];
     });
  } catch (e) {
     console.error("[Automation] RSOE EDIS failed:", e.message);
     return [];
  }
}

/**  Copernicus EMS (Rapid Mapping Activations & AOI Polygons) */
async function fetchCopernicusEMS() {
  const listUrl = `https://mapping.emergency.copernicus.eu/activations/api/activations/?limit=50`; 
  try {
     const resp = await fetch(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
     if (!resp.ok) return [];
     const data = await resp.json();
     if (!data.results) return [];

     const features = [];
     for (const e of data.results) {
        // Parse Centroid WKT
        const centroidMatch = e.centroid?.match(/POINT \((-?\d+\.\d+) (-?\d+\.\d+)\)/);
        let coords = [0, 0];
        if (centroidMatch) {
           coords = [parseFloat(centroidMatch[1]), parseFloat(centroidMatch[2])];
        }

        const isBboxMatch = coords[0] >= BBOX[0] && coords[0] <= BBOX[2] && coords[1] >= BBOX[1] && coords[1] <= BBOX[3];
        
        if (!isBboxMatch) continue;

        const catMap = { "flood": "flood", "fire": "fire", "storm": "storm", "volcan": "volcano", "earthquake": "earthquake" };
        const hazard = catMap[e.category?.slug] || "other";

        // Fetch Activation Details (which includes AOI Polygons)
        try {
           const actDetailUrl = `https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?code=${e.code}`;
           const actResp = await fetch(actDetailUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
           if (actResp.ok) {
              const actData = await actResp.json();
              const activationInfo = actData.results?.[0];
              if (activationInfo && activationInfo.aois && activationInfo.aois.length > 0) {
                 activationInfo.aois.forEach(aoi => {
                    // Copernicus AOIs use WKT "POLYGON ((...))" in the 'extent' field
                    if (aoi.extent) {
                       const polygonMatch = aoi.extent.match(/POLYGON \(\(([\s\S]*)\)\)/);
                       if (polygonMatch) {
                          const rings = polygonMatch[1].split("), (").map(ring => {
                             return ring.split(", ").map(pair => {
                                const [lon, lat] = pair.trim().split(" ");
                                return [parseFloat(lon), parseFloat(lat)];
                             });
                          });
                          
                          features.push({
                             type: "Feature",
                             geometry: { type: "Polygon", coordinates: rings }, 
                             properties: {
                                hazard: hazard,
                                severity: "high",
                                notes: `Copernicus EMS Layer: ${aoi.name} (AOI ${aoi.number}). Event: ${e.name} (${e.code}).`,
                                automated: true,
                                source: "copernicus",
                                sourceUrl: `https://mapping.emergency.copernicus.eu/activations/${e.code}/`,
                                extId: `ems_aoi_${aoi.id || aoi.number}_${e.code}`,
                                createdAt: new Date(e.activationTime).toLocaleString()
                             }
                          });
                       }
                    }
                 });
                 // If we successfully added AOI polygons, we skip adding the centroid fallback
                 continue; 
              }
           }
        } catch (aoiErr) {
           console.warn(`[Automation] AOIs fetch skip for ${e.code}:`, aoiErr.message);
        }

        // Fallback to point centroid if AOI details weren't available
        if (centroidMatch) {
           features.push({
              type: "Feature",
              geometry: { type: "Point", coordinates: coords },
              properties: {
                 hazard: hazard,
                 severity: "high",
                 notes: `Copernicus EMS Deployment: ${e.name} (${e.code}). ${e.search_snippet?.substring(0, 150)}...`,
                 automated: true,
                 source: "copernicus",
                 sourceUrl: `https://mapping.emergency.copernicus.eu/activations/${e.code}/`,
                 extId: `ems_${e.code}`,
                 createdAt: new Date(e.activationTime).toLocaleString()
              }
           });
        }
     }
     return recentProviderFeatures(features);
  } catch (e) {
    console.error("[Automation] Copernicus Surge failed:", e.message);
    return [];
  }
}

async function refreshAutomatedHazards() {
  if (isRefreshing) {
    console.log("[Automation] Refresh already in progress, skipping...");
    return;
  }
  const cycleStartedAt = new Date().toISOString();
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
    const successfulSources = new Set();
    const seenExtIds = new Set();
    let addedCount = 0;
    let updatedCount = 0;

    // 1.  FETCH SATELLITE DATA FIRST (USGS & NASA)
    console.log("[Automation] Fetching satellite earthquake data...");
    try {
      const quakes = recentProviderFeatures(await fetchUSGSEarthquakes());
      if (quakes && quakes.length > 0) {
        successfulSources.add("usgs");
        quakes.forEach(f => {
          seenExtIds.add(f.properties.extId);
          const idx = hazards.features.findIndex(h => h.properties && h.properties.extId === f.properties.extId);
          if (idx > -1) { hazards.features[idx] = f; updatedCount++; }
          else { hazards.features.push(f); addedCount++; }
        });
      }
    } catch (e) { console.warn("[Automation] USGS fetch failed, keeping old data."); }

    console.log("[Automation] Fetching satellite thermal data...");
    try {
      const fires = recentProviderFeatures(await fetchNASAFires());
      if (fires && fires.length > 0) {
        successfulSources.add("nasa");
        fires.forEach(f => {
          seenExtIds.add(f.properties.extId);
          const idx = hazards.features.findIndex(h => h.properties && h.properties.extId === f.properties.extId);
          if (idx > -1) { hazards.features[idx] = f; updatedCount++; }
          else { hazards.features.push(f); addedCount++; }
        });
      }
    } catch (e) { console.warn("[Automation] NASA Fires fetch failed, keeping old data."); }

    console.log("[Automation] Fetching NASA Observatory events (EONET)...");
    try {
      const eonetEvents = recentProviderFeatures(await fetchNASAEonet());
      if (eonetEvents && eonetEvents.length > 0) {
        successfulSources.add("nasa_eonet");
        eonetEvents.forEach(f => {
          seenExtIds.add(f.properties.extId);
          const idx = hazards.features.findIndex(h => h.properties && h.properties.extId === f.properties.extId);
          if (idx > -1) { hazards.features[idx] = f; updatedCount++; }
          else { hazards.features.push(f); addedCount++; }
        });
      }
    } catch (e) { console.warn("[Automation] EONET fetch failed, keeping old data."); }

    // 2.  FETCH GDACS (EXISTING)
    try {
      const gdacsUrl = "https://www.gdacs.org/xml/rss.xml";
      const resp = await fetchOfficial(gdacsUrl, { headers: { Accept: "application/xml, text/xml" } });
      {
        successfulSources.add("gdacs");
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
          const severity = $xml(el).find("gdacs\\:severity").text() || "medium";
          const fromDate = $xml(el).find("gdacs\\:fromdate").text() || "";
          const eventid = $xml(el).find("gdacs\\:eventid").text() || "";
          const eventTimestamp = timestampOf(fromDate);

          if (Number.isFinite(eventTimestamp) && Date.now() - eventTimestamp >= HAZARD_RETENTION_MS) continue;
          if (title && !isNaN(lat) && !isNaN(lng) && lng >= BBOX[0] && lng <= BBOX[2] && lat >= BBOX[1] && lat <= BBOX[3]) {
            const extId = `gdacs_${gdacsType}_${eventid}`;
            seenExtIds.add(extId);
            const categoryMap = { "eq": "earthquake", "tc": "storm", "fl": "flood", "wf": "fire", "vo": "volcano", "ls": "landslide", "dr": "drought", "hw": "heatwave" };
            const hazardType = categoryMap[gdacsType] || "other";
            const cleanTitle = formatDateString(title.replace(/^(Green|Orange|Red)\s+(notification for\s+)?/i, "").trim());
            const fullDesc = ($xml(el).find("description").text() || "").replace(/^(Green|Orange|Red)\s+/i, "").trim();
            const cleanDesc = formatDateString(fullDesc.replace(/^On\s+[A-Z][a-z]{2}\s+\d{1,2}.*?started.*?(until|to)\s+.*?\./i, "").trim());
            let impactLabel = "Minor";
            if (severity.toLowerCase() === "orange") impactLabel = "Moderate";
            if (severity.toLowerCase() === "red") impactLabel = "Significant";
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
            const summary = [`${impactLabel} GDACS alert.`, eventDate ? `Event date: ${eventDate}.` : "", impacts.length ? `Reported impact: ${impacts.join("; ")}.` : cleanDesc]
              .filter(Boolean).join(" ");

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
                lastUpdatedAt: fromDate || new Date().toISOString(),
                createdAt: fromDate || new Date().toISOString()
              },
              geometry: geometry
            };
            const existingIdx = hazards.features.findIndex(h => h.properties.extId === extId);
            if (existingIdx > -1) { hazards.features[existingIdx] = feature; updatedCount++; }
            else { hazards.features.push(feature); addedCount++; }
          }
        }
      }
    } catch (e) { console.warn("[Automation] GDACS fetch failed, keeping old data."); }

    const initialCount = hazards.features.length;
    hazards.features = hazards.features.filter(f => {
      if (!f.properties.extId) return true;
      const source = f.properties.source;
      const normalizedSource = source === "nasa" ? (f.properties.notes.includes("Observatory") ? "nasa_eonet" : "nasa") : source;
      if (successfulSources.has(normalizedSource)) {
         return seenExtIds.has(f.properties.extId);
      }
      return true; 
    });
    hazards.features = hazards.features.filter((feature) => isRecentProviderFeature(feature));
    const removedCount = initialCount - hazards.features.length;

    if (addedCount > 0 || updatedCount > 0 || removedCount > 0) {
      saveHazards(hazards);
      console.log(`[Automation] Satellite & GDACS Sync: ${addedCount} added, ${updatedCount} updated, ${removedCount} removed. Total: ${hazards.features.length}`);
    }

  } catch (err) {
    cycleFailed = true;
    console.error("[Automation] Refresh failed:", err.message);
  } finally {
    const cycleEndedAt = new Date().toISOString();
    saveHazardMetadata({
      lastHazardCheckAt: cycleEndedAt,
      lastHazardCheckCompletedAt: cycleEndedAt,
      lastHazardCheckStatus: cycleFailed ? "failed" : "ok"
    });
    isRefreshing = false;
    console.log("[Automation] Cycle complete.");
  }
}
const REFRESH_INTERVAL_MS = Math.max(1, Number(process.env.HAZARD_REFRESH_HOURS || 12)) * 60 * 60 * 1000;
const previousCheck = timestampOf(getHazards().lastHazardCheckCompletedAt);
const initialDelay = Number.isFinite(previousCheck)
  ? Math.max(0, REFRESH_INTERVAL_MS - (Date.now() - previousCheck))
  : 0;

setTimeout(() => {
  refreshAutomatedHazards();
  setInterval(refreshAutomatedHazards, REFRESH_INTERVAL_MS);
}, initialDelay);
console.log(`[Automation] Next combined provider refresh in ${Math.ceil(initialDelay / 60000)} minute(s).`);
