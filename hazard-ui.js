(function initializeHazardTaxonomy(globalObject) {
  const categories = Object.freeze([
    Object.freeze({ id: "flood", icon: "🌊", label: "Flooded Areas", color: "#0ea5e9" }),
    Object.freeze({ id: "fire", icon: "🔥", label: "Wildfire / Thermal", color: "#ef4444" }),
    Object.freeze({ id: "storm", icon: "🌀", label: "Storms / Cyclones", color: "#818cf8" }),
    Object.freeze({ id: "volcano", icon: "🌋", label: "Volcanic Activity", color: "#b91c1c" }),
    Object.freeze({ id: "landslide", icon: "⛰️", label: "Landslides / Mudslides", color: "#a16207" }),
    Object.freeze({ id: "earthquake", icon: "🫨", label: "Earthquake / Seismic", color: "#71717a" }),
    Object.freeze({ id: "drought", icon: "🏜️", label: "Drought / Water Scarcity", color: "#f59e0b" }),
    Object.freeze({ id: "heatwave", icon: "🌡️", label: "Extreme Heat", color: "#f97316" }),
    Object.freeze({ id: "other", icon: "⚠️", label: "Other Hazards", color: "#6366f1" }),
  ]);
  const byId = Object.freeze(Object.fromEntries(categories.map((category) => [category.id, category])));

  function normalize(value) {
    const text = String(value || "").toLowerCase();
    if (/(wildfire|forest fire|\bfire\b|thermal|burn|🔥)/.test(text)) return "fire";
    if (/(storm surge)/.test(text)) return "flood";
    if (/(storm|cyclone|hurricane|typhoon|tornado|lightning|thunder|windstorm|heavy rain|🌪️|🌀|⛈️)/.test(text)) return "storm";
    if (/(drought|water scarcity|arid|dry spell|🌵|🏜️)/.test(text)) return "drought";
    if (/(flood|inundation|storm surge|overflow|🌊)/.test(text)) return "flood";
    if (/(volcan|lava|eruption|volcanic ash|🌋)/.test(text)) return "volcano";
    if (/(landslide|mudslide|debris flow|rockfall|⛰️|🏔️)/.test(text)) return "landslide";
    if (/(earthquake|seismic|tremor|\bquake\b|🫨)/.test(text)) return "earthquake";
    if (/(heatwave|heat wave|extreme heat|high temperature|🌡️)/.test(text)) return "heatwave";
    return byId[text]?.id || "other";
  }

  function iconFor(value, context = "") {
    const category = normalize(value);
    if (category !== "storm") return byId[category]?.icon || byId.other.icon;
    const detail = `${value || ""} ${context || ""}`.toLowerCase();
    if (/(lightning|thunder|⛈️)/.test(detail)) return "⛈️";
    if (/(tornado|🌪️)/.test(detail)) return "🌪️";
    return byId.storm.icon;
  }

  globalObject.AlertlyHazards = Object.freeze({ categories, byId, normalize, iconFor });
})(globalThis);
