(function initializeHazardTaxonomy(globalObject) {
  const categories = Object.freeze([
    Object.freeze({ id: "flood", icon: "/assets/hazards/flood.svg", label: "Flooded Areas", color: "#0ea5e9" }),
    Object.freeze({ id: "fire", icon: "/assets/hazards/fire.svg", label: "Wildfire / Thermal", color: "#ef4444" }),
    Object.freeze({ id: "storm", icon: "/assets/hazards/storm.svg", label: "Storms / Cyclones", color: "#818cf8" }),
    Object.freeze({ id: "volcano", icon: "/assets/hazards/volcano.svg", label: "Volcanic Activity", color: "#b91c1c" }),
    Object.freeze({ id: "landslide", icon: "/assets/hazards/landslide.svg", label: "Landslides / Mudslides", color: "#a16207" }),
    Object.freeze({ id: "earthquake", icon: "/assets/hazards/earthquake.svg", label: "Earthquake / Seismic", color: "#71717a" }),
    Object.freeze({ id: "drought", icon: "/assets/hazards/drought.svg", label: "Drought / Water Scarcity", color: "#f59e0b" }),
    Object.freeze({ id: "heatwave", icon: "/assets/hazards/heatwave.svg", label: "Extreme Heat", color: "#f97316" }),
    Object.freeze({ id: "other", icon: "/assets/hazards/other.svg", label: "Other Hazards", color: "#6366f1" }),
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
    if (/(lightning|thunder|⛈️)/.test(detail)) return "/assets/hazards/lightning-storm.svg";
    return byId.storm.icon;
  }

  function iconMarkupFor(value, context = "", className = "hazard-icon") {
    const safeClassName = String(className || "hazard-icon").replace(/[^a-z0-9 _-]/gi, "").trim() || "hazard-icon";
    return `<img class="${safeClassName}" src="${iconFor(value, context)}" alt="" aria-hidden="true">`;
  }

  function createIcon(value, context = "", className = "hazard-icon") {
    const image = globalObject.document.createElement("img");
    image.className = className;
    image.src = iconFor(value, context);
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    return image;
  }

  globalObject.AlertlyHazards = Object.freeze({ categories, byId, normalize, iconFor, iconMarkupFor, createIcon });
})(globalThis);
