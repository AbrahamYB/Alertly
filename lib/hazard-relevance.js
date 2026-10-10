import { isPublicEarthquake } from "./earthquake-policy.js";

const SUPPORTED_COPERNICUS_HAZARDS = new Set([
  "earthquake",
  "fire",
  "flood",
  "landslide",
  "storm",
  "volcano",
]);

export function isActionableGdacsEvent({ providerActive, alertLevel }) {
  const level = String(alertLevel || "").toLowerCase();
  return providerActive === true && (level === "orange" || level === "red");
}

export function isActionableCopernicusActivation({ hazard, drmPhase, closed, lastUpdate, activationTime }, now, retentionMs) {
  if (!SUPPORTED_COPERNICUS_HAZARDS.has(String(hazard || "").toLowerCase())) return false;
  if (String(drmPhase || "").toLowerCase() !== "response") return false;
  if (!closed) return true;
  const updatedAt = new Date(lastUpdate || activationTime).getTime();
  return Number.isFinite(updatedAt) && now - updatedAt < retentionMs;
}

export function isActionableAutomatedHazard(feature) {
  const properties = feature?.properties || {};
  if (!properties.automated) return true;
  switch (String(properties.source || "").toLowerCase()) {
    case "usgs":
      return isPublicEarthquake(properties);
    case "gdacs":
      return ["orange", "red"].includes(String(properties.alertLevel || "").toLowerCase());
    case "copernicus":
      return SUPPORTED_COPERNICUS_HAZARDS.has(String(properties.hazard || "").toLowerCase());
    default:
      return false;
  }
}
