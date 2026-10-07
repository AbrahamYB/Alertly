import fs from "fs";

export function readProviderStatus(metadataFile) {
  let metadata = {};
  try { metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")); } catch { /* first local run */ }

  const enabled = process.env.ENABLE_AUTOMATION === "true";
  const configured = [
    ["USGS Earthquakes", "usgs", true],
    ["NASA EONET", "nasa_eonet", true],
    ["GDACS", "gdacs", true],
    ["NASA FIRMS", "nasa_firms", Boolean(process.env.FIRMS_MAP_KEY)],
  ];

  return {
    checkedAt: new Date().toISOString(),
    providers: configured.map(([name, id, hasCredentials]) => {
      const state = metadata.providerStatus?.[id] || {};
      const lastSuccess = state.lastSuccessAt || null;
      const stale = Boolean(lastSuccess) && Date.now() - new Date(lastSuccess).getTime() > 30 * 60 * 1000;
      const active = enabled && hasCredentials;
      return {
        name,
        status: active ? (state.status === "error" || stale ? "delayed" : "healthy") : "disabled",
        stale: active && stale,
        lastSuccess,
        message: !enabled ? "Background collection is disabled." : !hasCredentials ? "A FIRMS_MAP_KEY is required." : state.message || "Waiting for the first provider check.",
      };
    }),
  };
}
