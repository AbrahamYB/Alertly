const DEFAULT_HAZARD_BBOX = [-180, -60, 180, 85];

export function getHazardBbox() {
  const configured = String(process.env.HAZARD_BBOX || "")
    .split(",")
    .map((value) => Number(value.trim()));
  if (configured.length !== 4 || configured.some((value) => !Number.isFinite(value))) {
    return [...DEFAULT_HAZARD_BBOX];
  }
  const [minLng, minLat, maxLng, maxLat] = configured;
  return minLng < maxLng && minLat < maxLat ? configured : [...DEFAULT_HAZARD_BBOX];
}

export function coordinatesInBbox(coordinates, bbox = getHazardBbox()) {
  if (!Array.isArray(coordinates)) return false;
  if (coordinates.length >= 2 && Number.isFinite(Number(coordinates[0])) && Number.isFinite(Number(coordinates[1]))) {
    const [lng, lat] = coordinates.map(Number);
    return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
  }
  return coordinates.some((item) => coordinatesInBbox(item, bbox));
}

export function featureInHazardRegion(feature, bbox = getHazardBbox()) {
  return coordinatesInBbox(feature?.geometry?.coordinates, bbox);
}
