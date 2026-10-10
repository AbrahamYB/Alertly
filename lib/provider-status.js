import fs from "fs";

export function readProviderStatus(metadataFile) {
  let metadata = {};
  try { metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")); } catch { /* first local run */ }

  const enabled = process.env.ENABLE_AUTOMATION === "true";
  const configured = [
    ["USGS PAGER earthquakes", "usgs", true, "disabled"],
    ["NASA EONET", "nasa_eonet", false, "supporting-only"],
    ["GDACS humanitarian alerts", "gdacs", true, "disabled"],
    ["RSOE EDIS clusters", "rsoe_edis", false, "disabled"],
    ["Copernicus EMS", "copernicus", true, "disabled"],
    ["NASA FIRMS hotspots", "nasa_firms", false, "supporting-only"],
  ];
  const staleAfterMs = Math.max(1, Number(process.env.PROVIDER_STALE_HOURS || 13)) * 60 * 60 * 1000;

  return {
    checkedAt: new Date().toISOString(),
    providers: configured.map(([name, id, publishesIncidents, inactiveStatus]) => {
      const state = metadata.providerStatus?.[id] || {};
      const lastSuccess = state.lastSuccessAt || null;
      const lastSuccessTime = new Date(lastSuccess).getTime();
      const stale = Boolean(lastSuccess) && (!Number.isFinite(lastSuccessTime) || Date.now() - lastSuccessTime > staleAfterMs);
      const active = enabled && publishesIncidents;
      return {
        name,
        status: active
          ? (!lastSuccess ? "waiting" : state.status === "error" || stale ? "delayed" : "healthy")
          : enabled ? state.status || inactiveStatus : "disabled",
        stale: active && stale,
        lastSuccess,
        message: !enabled
          ? "Background collection is disabled."
          : state.message || (publishesIncidents
            ? "Waiting for the first provider check."
            : "This source does not independently prove public impact and is not published."),
      };
    }),
  };
}
