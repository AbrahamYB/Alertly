export const DEFAULT_USGS_MIN_MAGNITUDE = 2.5;

export function isPublicEarthquake(properties, minimumMagnitude = DEFAULT_USGS_MIN_MAGNITUDE) {
  const magnitude = Number(properties?.mag);
  return Number.isFinite(magnitude) && magnitude >= minimumMagnitude;
}
