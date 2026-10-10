const PAGER_LEVELS = new Map([
  ["green", 0],
  ["yellow", 1],
  ["orange", 2],
  ["red", 3],
]);

export function isPublicEarthquake(properties) {
  const alertLevel = String(properties?.alert || properties?.pagerAlert || "").toLowerCase();
  return (PAGER_LEVELS.get(alertLevel) ?? -1) >= PAGER_LEVELS.get("yellow");
}
