import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import fs from "fs";
import { getHazardBbox } from "./lib/hazard-region.js";
import { nextScheduledTime, parseDailyTimes } from "./lib/fixed-schedule.js";
import { replaceFileSync } from "./lib/file-utils.js";
import { isDeprecatedHazardFeature, isHazardCurrent } from "./lib/domain.js";
import { isPublicEarthquake } from "./lib/earthquake-policy.js";
import { isActionableCopernicusActivation } from "./lib/hazard-relevance.js";
import { resolveCopernicusEventLocation } from "./lib/hazard-location.js";
import {
  classifyIfrcHazard,
  extractIfrcImpactCounts,
  formatIfrcImpactCounts,
  hasVerifiedIfrcImpact,
  ifrcSeverity,
  latestPublicFieldReport,
  summarizeIfrcNarrative,
} from "./lib/ifrc-impact.js";
import { buildFemaFeatures, buildNifcFeatures } from "./lib/official-incidents.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HAZARDS_FILE = process.env.HAZARDS_FILE
  ? path.resolve(process.env.HAZARDS_FILE)
  : path.join(__dirname, "hazards.geojson");
const HAZARD_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;

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

function removeNonIncidentHeatDetections(hazards) {
  if (!Array.isArray(hazards?.features)) return 0;
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
    removeNonIncidentHeatDetections(data);
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
    const removedCount = removeNonIncidentHeatDetections(hazards);
    if (removedCount > 0) {
      console.log(`[Automation] Removed ${removedCount} raw heat detection${removedCount === 1 ? "" : "s"}; only impact-backed incidents are public.`);
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

let isRefreshing = false;

async function fetchUSGSEarthquakes() {
  const startTime = new Date(Date.now() - HAZARD_RETENTION_MS).toISOString();
  const params = new URLSearchParams({
    format: "geojson",
    eventtype: "earthquake",
    starttime: startTime,
    minalertlevel: "yellow",
    orderby: "time-asc",
    limit: "20000",
  });
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?${params}`;
  try {
    const resp = await fetchOfficial(url);
    const data = await resp.json();
    return (data.features || []).filter(f => {
      const [lng, lat] = f.geometry.coordinates;
      return isPublicEarthquake(f.properties)
        && lng >= BBOX[0] && lng <= BBOX[2] && lat >= BBOX[1] && lat <= BBOX[3];
    }).map(f => ({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        hazard: "earthquake",
        severity: ["orange", "red"].includes(String(f.properties.alert).toLowerCase()) ? "high" : "medium",
        title: f.properties.title || `M ${f.properties.mag} - ${f.properties.place}`,
        confidence: f.properties.status === "reviewed" ? "confirmed" : "probable",
        notes: [
          `Magnitude ${f.properties.mag}; depth ${f.geometry.coordinates[2]} km.`,
          `USGS PAGER impact alert: ${String(f.properties.alert).toUpperCase()}.`,
          Number.isFinite(Number(f.properties.mmi)) ? `Maximum estimated intensity: MMI ${Number(f.properties.mmi).toFixed(1)}.` : "",
          Number.isFinite(Number(f.properties.cdi)) ? `Maximum reported intensity: ${Number(f.properties.cdi).toFixed(1)}.` : "",
          Number(f.properties.felt) > 0 ? `${Number(f.properties.felt).toLocaleString("en-US")} felt report(s).` : "",
        ].filter(Boolean).join(" "),
        automated: true,
        source: "usgs",
        sourceType: "official seismic feed",
        sourceUrl: f.properties.url,
        extId: `usgs_${f.id}`,
        magnitude: Number(f.properties.mag),
        significance: Number(f.properties.sig),
        pagerAlert: String(f.properties.alert || "").toLowerCase(),
        maxEstimatedIntensity: Number.isFinite(Number(f.properties.mmi)) ? Number(f.properties.mmi) : undefined,
        maxReportedIntensity: Number.isFinite(Number(f.properties.cdi)) ? Number(f.properties.cdi) : undefined,
        feltReports: Number(f.properties.felt) || 0,
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

function cleanIfrcTitle(value) {
  return String(value || "")
    .replace(/^[A-Z]{3}:\s*/, "")
    .replace(/\s+-\s+\d{2}-\d{4}\s+-\s+/i, " — ")
    .replace(/^Other\s+—\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function descriptiveIfrcTitle(value, hazard, countryNames) {
  const cleaned = cleanIfrcTitle(value);
  const labels = {
    earthquake: "Earthquake", fire: "Fire", flood: "Flood", storm: "Storm",
    volcano: "Volcanic activity", landslide: "Landslide", drought: "Drought", heatwave: "Extreme heat",
  };
  const hazardWords = {
    earthquake: /earthquake|seismic/i, fire: /fire|burn/i, flood: /flood|inundat/i,
    storm: /storm|cyclone|hurricane|typhoon|wind/i, volcano: /volcan|eruption/i,
    landslide: /landslide|mudslide|debris flow/i, drought: /drought|water scarcity/i,
    heatwave: /heat|temperature/i,
  };
  if (cleaned && hazardWords[hazard]?.test(cleaned)) return cleaned;
  const fallback = cleaned || `emergency in ${countryNames.join(", ")}`;
  return `${labels[hazard] || "Hazard"} — ${fallback}`;
}

function plainTextFromHtml(value) {
  if (!value) return "";
  return cheerio.load(String(value)).text().replace(/\s+/g, " ").trim();
}

async function fetchIfrcVerifiedIncidents() {
  const evidenceCutoff = Date.now() - HAZARD_RETENTION_MS;
  const updatedAfter = new Date(evidenceCutoff).toISOString();
  const eventParams = new URLSearchParams({
    limit: "200",
    ordering: "-updated_at",
    updated_at__gte: updatedAfter,
  });
  try {
    const [eventResponse, countryResponse] = await Promise.all([
      fetchOfficial(`https://goadmin.ifrc.org/api/v2/event/?${eventParams}`),
      fetchOfficial("https://goadmin.ifrc.org/api/v2/country/?limit=400"),
    ]);
    const [eventData, countryData] = await Promise.all([eventResponse.json(), countryResponse.json()]);
    if (!Array.isArray(eventData.results) || !Array.isArray(countryData.results)) throw new Error("Invalid IFRC GO response.");
    const countriesById = new Map(countryData.results.map(country => [Number(country.id), country]));
    const districtRequests = new Map();
    const fetchDistrict = async id => {
      if (!districtRequests.has(id)) {
        districtRequests.set(id, fetchOfficial(`https://goadmin.ifrc.org/api/v2/district/${id}/`)
          .then(response => response.json())
          .catch(error => {
            console.warn(`[Automation] IFRC district ${id} location unavailable:`, error.message);
            return null;
          }));
      }
      return districtRequests.get(id);
    };
    const features = [];

    for (const event of eventData.results) {
      const hazard = classifyIfrcHazard(event);
      if (!hazard) continue;
      const report = latestPublicFieldReport(event);
      const narrative = plainTextFromHtml(report?.description || report?.summary || event.summary);
      const impactCounts = extractIfrcImpactCounts(event, report);
      if (!hasVerifiedIfrcImpact(impactCounts, narrative)) continue;

      const eventCountries = (event.countries || [])
        .map(country => countriesById.get(Number(country.id)) || country)
        .filter(Boolean);
      const primaryCountry = eventCountries.find(country => Array.isArray(country.centroid?.coordinates)) || null;
      let districtReferences = event.districts || [];
      if (!districtReferences.length && event.id) {
        try {
          const detailResponse = await fetchOfficial(`https://goadmin.ifrc.org/api/v2/event/${event.id}/`);
          const eventDetail = await detailResponse.json();
          districtReferences = eventDetail.districts || [];
        } catch (error) {
          console.warn(`[Automation] IFRC event ${event.id} district list unavailable:`, error.message);
        }
      }
      const eventDistricts = (await Promise.all(districtReferences
        .map(district => Number(district.id))
        .filter(Number.isFinite)
        .map(fetchDistrict)))
        .filter(district => Array.isArray(district?.centroid?.coordinates));
      const districtCoordinates = eventDistricts.map(district => district.centroid.coordinates.map(Number));
      const coordinates = districtCoordinates.length
        ? [
            districtCoordinates.reduce((sum, point) => sum + point[0], 0) / districtCoordinates.length,
            districtCoordinates.reduce((sum, point) => sum + point[1], 0) / districtCoordinates.length,
          ]
        : primaryCountry?.centroid?.coordinates?.map(Number);
      if (!coordinates || coordinates.length < 2 || !coordinates.every(Number.isFinite)) continue;
      const [lng, lat] = coordinates;
      if (lng < BBOX[0] || lng > BBOX[2] || lat < BBOX[1] || lat > BBOX[3]) continue;

      const countryNames = eventCountries.map(country => String(country.name || "").trim()).filter(Boolean);
      const districtNames = eventDistricts.map(district => String(district.name || "").trim()).filter(Boolean);
      const impacts = formatIfrcImpactCounts(impactCounts);
      const narrativeSummary = summarizeIfrcNarrative(narrative);
      const detectedAt = isoTimestamp(event.disaster_start_date || event.created_at);
      const updatedAt = isoTimestamp(report?.updated_at || event.updated_at || event.created_at);
      // The API can return older records even with updated_at__gte. Enforce the
      // 15-day evidence lifecycle locally using the public report timestamp.
      if (timestampOf(updatedAt) < evidenceCutoff) continue;
      const severityLevel = String(event.ifrc_severity_level_display || "").trim();
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: {
          hazard,
          severity: ifrcSeverity(event, impactCounts),
          confidence: "confirmed",
          title: descriptiveIfrcTitle(event.name, hazard, countryNames),
          notes: [
            `Verified IFRC humanitarian field report${countryNames.length ? ` for ${countryNames.join(", ")}` : ""}.`,
            impacts.length ? `Reported impact: ${impacts.join("; ")}.` : "",
            severityLevel ? `IFRC alert level: ${severityLevel}.` : "",
            narrativeSummary,
          ].filter(Boolean).join(" "),
          automated: true,
          source: "ifrc_go",
          sourceType: "verified humanitarian field report",
          sourceUrl: `https://go.ifrc.org/emergencies/${event.id}`,
          extId: `ifrc_${event.id}`,
          ifrcEventId: Number(event.id),
          ifrcImpactVerified: true,
          countryNames,
          countryCodes: eventCountries.map(country => country.iso3).filter(Boolean),
          districtNames,
          locationLabel: districtNames.length ? districtNames.join(", ") : countryNames.join(", "),
          reportedImpacts: impactCounts,
          providerSeverity: severityLevel || undefined,
          locationEstimated: true,
          detectedAt,
          lastUpdatedAt: updatedAt,
          createdAt: detectedAt,
        },
      });
    }
    return features;
  } catch (error) {
    console.error("[Automation] IFRC GO fetch failed:", error.message);
    return null;
  }
}

async function fetchFemaDeclarations() {
  const cutoffMs = Date.now() - HAZARD_RETENTION_MS;
  const params = new URLSearchParams({
    $filter: `declarationDate ge '${new Date(cutoffMs).toISOString()}'`,
    $orderby: "declarationDate desc",
    $top: "1000",
  });
  try {
    const response = await fetchOfficial(`https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?${params}`);
    const data = await response.json();
    if (!Array.isArray(data.DisasterDeclarationsSummaries)) throw new Error("Invalid OpenFEMA response.");
    const centersByDisaster = new Map();
    try {
      const geometryBase = "https://gis.fema.gov/arcgis/rest/services/FEMA/DECs/FeatureServer";
      const metadataResponse = await fetchOfficial(`${geometryBase}?f=json`);
      const metadata = await metadataResponse.json();
      const disasterNumbers = [...new Set(data.DisasterDeclarationsSummaries.map(row => Number(row.disasterNumber)).filter(Number.isFinite))];
      const centerResults = await Promise.all(disasterNumbers.map(async disasterNumber => {
        const layer = (metadata.layers || []).find(candidate => String(candidate.name || "").includes(`-${disasterNumber}-`));
        if (!layer) return null;
        const extentParams = new URLSearchParams({ where: "1=1", returnExtentOnly: "true", outSR: "4326", f: "json" });
        const extentResponse = await fetchOfficial(`${geometryBase}/${layer.id}/query?${extentParams}`);
        const extent = (await extentResponse.json()).extent;
        if (![extent?.xmin, extent?.ymin, extent?.xmax, extent?.ymax].every(Number.isFinite)) return null;
        return [disasterNumber, [(extent.xmin + extent.xmax) / 2, (extent.ymin + extent.ymax) / 2]];
      }));
      for (const result of centerResults) if (result) centersByDisaster.set(result[0], result[1]);
    } catch (geometryError) {
      console.warn("[Automation] FEMA declared-area geometry unavailable; using disclosed state centers:", geometryError.message);
    }
    return buildFemaFeatures(data.DisasterDeclarationsSummaries, { cutoffMs, bbox: BBOX, centersByDisaster });
  } catch (error) {
    console.error("[Automation] OpenFEMA fetch failed:", error.message);
    return null;
  }
}

async function fetchNifcWildfires() {
  const cutoffMs = Date.now() - HAZARD_RETENTION_MS;
  const baseUrl = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query";
  const params = new URLSearchParams({
    where: "IncidentTypeCategory = 'WF'",
    outFields: [
      "IncidentName", "IncidentShortDescription", "IncidentTypeCategory", "IncidentSize",
      "PercentContained", "TotalIncidentPersonnel", "FireOutDateTime", "FireDiscoveryDateTime",
      "ModifiedOnDateTime_dt", "IrwinID", "UniqueFireIdentifier", "GlobalID", "POOState",
    ].join(","),
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });
  try {
    const response = await fetchOfficial(`${baseUrl}?${params}`);
    const data = await response.json();
    if (!Array.isArray(data.features)) throw new Error("Invalid NIFC response.");
    return buildNifcFeatures(data.features, { cutoffMs, bbox: BBOX });
  } catch (error) {
    console.error("[Automation] NIFC fetch failed:", error.message);
    return null;
  }
}

function incidentDate(feature) {
  return timestampOf(feature?.properties?.detectedAt || feature?.properties?.createdAt);
}

function supportsIfrcIncident(ifrcFeature, supportingFeature) {
  if (ifrcFeature?.properties?.hazard !== supportingFeature?.properties?.hazard) return false;
  const ifrcDate = incidentDate(ifrcFeature);
  const supportingDate = incidentDate(supportingFeature);
  if (!Number.isFinite(ifrcDate) || !Number.isFinite(supportingDate) || Math.abs(ifrcDate - supportingDate) > 7 * 24 * 60 * 60 * 1000) return false;
  const supportingText = `${supportingFeature.properties?.title || ""} ${supportingFeature.properties?.countries || ""}`.toLowerCase();
  return (ifrcFeature.properties?.countryNames || []).some(country => supportingText.includes(String(country).toLowerCase()));
}

function correlateVerifiedIncidents(ifrcFeatures, usgsFeatures, copernicusFeatures) {
  if (!Array.isArray(ifrcFeatures)) return { ifrcFeatures, copernicusFeatures };
  const locationSources = [...(usgsFeatures || []), ...(copernicusFeatures || [])];
  const matchedCopernicusIds = new Set();
  for (const feature of ifrcFeatures) {
    const matches = locationSources.filter(candidate => supportsIfrcIncident(feature, candidate));
    for (const match of matches) {
      if (match.properties?.source === "copernicus") matchedCopernicusIds.add(String(match.properties.extId));
    }
    const bestLocation = matches.sort((left, right) => {
      if (feature.properties.hazard === "earthquake") {
        const sourceDifference = Number(right.properties?.source === "usgs") - Number(left.properties?.source === "usgs");
        if (sourceDifference) return sourceDifference;
        return Number(right.properties?.magnitude || 0) - Number(left.properties?.magnitude || 0);
      }
      return Number(right.properties?.source === "copernicus") - Number(left.properties?.source === "copernicus");
    })[0];
    if (!bestLocation) continue;
    feature.geometry = bestLocation.geometry;
    feature.properties.locationEstimated = Boolean(bestLocation.properties?.locationEstimated);
    const sourceName = bestLocation.properties?.source === "usgs" ? "USGS epicenter" : "Copernicus emergency activation";
    feature.properties.locationLabel = bestLocation.properties?.locationLabel || sourceName;
    feature.properties.supportingSourceUrl = bestLocation.properties?.sourceUrl;
  }
  return {
    ifrcFeatures,
    copernicusFeatures: Array.isArray(copernicusFeatures)
      ? copernicusFeatures.filter(feature => !matchedCopernicusIds.has(String(feature.properties?.extId)))
      : copernicusFeatures,
  };
}

// Copernicus EMS rapid-mapping activations and AOI polygons.
async function fetchCopernicusEMS() {
  const listUrl = `https://mapping.emergency.copernicus.eu/activations/api/activations/?limit=50`; 
  try {
     const resp = await fetchOfficial(listUrl);
     const data = await resp.json();
     if (!Array.isArray(data.results)) throw new Error("Invalid Copernicus response.");

     const features = [];
     let detailFetchFailed = false;
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
          : categorySlug.includes("landslide") || categorySlug.includes("mudslide") ? "landslide"
          : "other";
        if (!isActionableCopernicusActivation({
          hazard,
          drmPhase: e.drmPhase,
          closed: e.closed,
          lastUpdate: e.lastUpdate,
          activationTime: e.activationTime,
        }, Date.now(), HAZARD_RETENTION_MS)) continue;

        let mappedAreaSummary = "";
        let areaNames = [];
        let activationReason = "";
        let productCount = Number(e.n_products) || 0;
        try {
           const actDetailUrl = `https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?code=${e.code}`;
           const actResp = await fetchOfficial(actDetailUrl);
           if (actResp.ok) {
              const actData = await actResp.json();
              const activationInfo = actData.results?.[0];
              activationReason = String(activationInfo?.reason || "").replace(/\s+/g, " ").trim();
              if (activationInfo && activationInfo.aois && activationInfo.aois.length > 0) {
                 areaNames = [...new Set(activationInfo.aois.map((aoi) => String(aoi.name || "").trim()).filter(Boolean))];
                 productCount = activationInfo.aois.reduce((total, aoi) => total + (Array.isArray(aoi.products) ? aoi.products.length : 0), 0) || productCount;
                 const areaLabel = areaNames.slice(0, 3).join(", ");
                 mappedAreaSummary = ` Copernicus mapped ${activationInfo.aois.length} area${activationInfo.aois.length === 1 ? "" : "s"}${areaLabel ? ` (${areaLabel})` : ""}.`;
              }
           }
        } catch (aoiErr) {
           detailFetchFailed = true;
           console.warn(`[Automation] AOIs fetch skip for ${e.code}:`, aoiErr.message);
        }

        if (!activationReason || !hasVerifiedIfrcImpact({}, activationReason)) continue;

        // AOI extents describe mapping coverage, not the hazard footprint. Use one
        // event marker so the map does not imply that the entire AOI is affected.
        if (centroidMatch) {
           const activationAt = isoTimestamp(e.activationTime);
           const updatedAt = isoTimestamp(e.lastUpdate || e.activationTime);
           const countries = (e.countries || []).map(country => country.short_name).filter(Boolean).join(", ");
           const providerSummary = activationReason || String(e.search_snippet || "").replace(/\s+/g, " ").trim();
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
                 notes: [
                   `Copernicus emergency-response activation ${e.code}${countries ? ` for ${countries}` : ""}.`,
                   providerSummary,
                   `${productCount} mapping product(s); ${Number(e.n_aois) || areaNames.length || 0} requested area(s).`,
                   mappedAreaSummary.trim(),
                 ].filter(Boolean).join(" "),
                 automated: true,
                 source: "copernicus",
                 sourceType: "official emergency mapping activation",
                 sourceUrl: `https://mapping.emergency.copernicus.eu/activations/${e.code}/`,
                 extId: `ems_${e.code}`,
                 locationEstimated: location.estimated,
                 responsePhase: String(e.drmPhase || "response"),
                 providerClosed: Boolean(e.closed),
                 countries,
                 locationLabel: areaNames.length ? areaNames.join(", ") : countries,
                 mappingProducts: productCount,
                 mappedAreas: Number(e.n_aois) || areaNames.length || 0,
                 detectedAt: activationAt,
                 lastUpdatedAt: updatedAt,
                 createdAt: activationAt
              }
           });
        }
     }
     if (detailFetchFailed) throw new Error("One or more Copernicus activation details could not be verified.");
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

    console.log("[Automation] Fetching USGS PAGER data for incident corroboration...");
    const usgsFeatures = await fetchUSGSEarthquakes();
    reconcileProviderSnapshot("usgs", []);
    providerStatus.usgs = Array.isArray(usgsFeatures)
      ? {
          status: "supporting-only",
          lastAttemptAt: new Date().toISOString(),
          lastSuccessAt: new Date().toISOString(),
          itemCount: usgsFeatures.length,
          message: `${usgsFeatures.length} PAGER impact alert${usgsFeatures.length === 1 ? "" : "s"} available only to corroborate verified incidents.`,
        }
      : {
          ...(providerStatus.usgs || {}),
          status: "error",
          lastAttemptAt: new Date().toISOString(),
          message: "USGS corroboration failed; it does not create public incidents independently.",
        };

    providerStatus.nasa_firms = {
      status: "supporting-only",
      lastAttemptAt: new Date().toISOString(),
      itemCount: 0,
      message: "Raw thermal pixels are not public incidents because they do not prove a damaging wildfire.",
    };
    providerStatus.nasa_eonet = {
      status: "supporting-only",
      lastAttemptAt: new Date().toISOString(),
      itemCount: 0,
      message: "EONET visualization metadata is not published without independent impact evidence.",
    };
    providerStatus.rsoe_edis = {
      status: "disabled",
      lastAttemptAt: new Date().toISOString(),
      itemCount: 0,
      message: "The aggregate cluster endpoint lacks stable incident-level impact evidence.",
    };
    providerStatus.gdacs = {
      status: "supporting-only",
      lastAttemptAt: new Date().toISOString(),
      itemCount: 0,
      message: "GDACS modelled alerts do not independently prove observed harm and are not public incidents.",
    };
    reconcileProviderSnapshot("gdacs", []);

    console.log("[Automation] Fetching Copernicus EMS activations...");
    const copernicusFeatures = await fetchCopernicusEMS();
    console.log("[Automation] Fetching verified IFRC humanitarian incidents...");
    const rawIfrcFeatures = await fetchIfrcVerifiedIncidents();
    const correlated = correlateVerifiedIncidents(rawIfrcFeatures, usgsFeatures, copernicusFeatures);
    if (Array.isArray(correlated.ifrcFeatures)) reconcileProviderSnapshot("ifrc_go", correlated.ifrcFeatures);
    mergeProviderFeatures("ifrc_go", correlated.ifrcFeatures);
    if (Array.isArray(correlated.copernicusFeatures)) reconcileProviderSnapshot("copernicus", correlated.copernicusFeatures);
    mergeProviderFeatures("copernicus", correlated.copernicusFeatures);

    console.log("[Automation] Fetching recent FEMA disaster declarations...");
    const femaFeatures = await fetchFemaDeclarations();
    if (Array.isArray(femaFeatures)) reconcileProviderSnapshot("fema", femaFeatures);
    mergeProviderFeatures("fema", femaFeatures);

    console.log("[Automation] Fetching significant current NIFC wildfires...");
    const nifcFeatures = await fetchNifcWildfires();
    if (Array.isArray(nifcFeatures)) reconcileProviderSnapshot("nifc_irwin", nifcFeatures);
    mergeProviderFeatures("nifc_irwin", nifcFeatures);

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
