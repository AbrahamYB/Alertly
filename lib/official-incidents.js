const FEMA_STATE_CENTERS = {
  AK: [-152.4, 64.2], AL: [-86.8, 32.8], AR: [-92.4, 34.9], AS: [-170.7, -14.3], AZ: [-111.9, 34.3],
  CA: [-119.7, 37.2], CO: [-105.5, 39.0], CT: [-72.7, 41.6], DC: [-77.0, 38.9], DE: [-75.5, 39.0],
  FL: [-82.5, 28.6], GA: [-83.4, 32.7], GU: [144.8, 13.4], HI: [-157.5, 20.9], IA: [-93.5, 42.1],
  ID: [-114.6, 44.2], IL: [-89.2, 40.0], IN: [-86.3, 39.9], KS: [-98.4, 38.5], KY: [-85.3, 37.5],
  LA: [-92.0, 31.0], MA: [-71.8, 42.3], MD: [-76.7, 39.0], ME: [-69.2, 45.3], MI: [-85.4, 44.3],
  MN: [-94.3, 46.3], MO: [-92.5, 38.5], MP: [145.7, 15.2], MS: [-89.7, 32.7], MT: [-109.6, 47.0],
  NC: [-79.4, 35.5], ND: [-100.5, 47.5], NE: [-99.8, 41.5], NH: [-71.6, 43.7], NJ: [-74.5, 40.1],
  NM: [-106.1, 34.4], NV: [-116.7, 39.3], NY: [-75.5, 42.9], OH: [-82.8, 40.3], OK: [-97.5, 35.6],
  OR: [-120.6, 44.0], PA: [-77.7, 40.9], PR: [-66.5, 18.2], RI: [-71.5, 41.7], SC: [-80.9, 33.8],
  SD: [-100.2, 44.4], TN: [-86.4, 35.8], TX: [-99.3, 31.5], UT: [-111.7, 39.3], VA: [-78.7, 37.5],
  VI: [-64.8, 18.0], VT: [-72.7, 44.1], WA: [-120.7, 47.4], WI: [-89.7, 44.6], WV: [-80.6, 38.6],
  WY: [-107.6, 43.0],
};

const FEMA_STATE_NAMES = {
  AK: "Alaska", AL: "Alabama", AR: "Arkansas", AS: "American Samoa", AZ: "Arizona", CA: "California",
  CO: "Colorado", CT: "Connecticut", DC: "District of Columbia", DE: "Delaware", FL: "Florida", GA: "Georgia",
  GU: "Guam", HI: "Hawaii", IA: "Iowa", ID: "Idaho", IL: "Illinois", IN: "Indiana", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", MA: "Massachusetts", MD: "Maryland", ME: "Maine", MI: "Michigan",
  MN: "Minnesota", MO: "Missouri", MP: "Northern Mariana Islands", MS: "Mississippi", MT: "Montana",
  NC: "North Carolina", ND: "North Dakota", NE: "Nebraska", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NV: "Nevada", NY: "New York", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", PR: "Puerto Rico", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VA: "Virginia", VI: "U.S. Virgin Islands", VT: "Vermont",
  WA: "Washington", WI: "Wisconsin", WV: "West Virginia", WY: "Wyoming",
};

const FEMA_INCIDENT_TYPES = [
  [/earthquake/i, "earthquake"],
  [/fire/i, "fire"],
  [/flood/i, "flood"],
  [/hurricane|typhoon|tropical storm|severe storm|coastal storm|tornado|snowstorm|freez/i, "storm"],
  [/volcan/i, "volcano"],
  [/landslide|mudslide/i, "landslide"],
  [/drought/i, "drought"],
  [/heat/i, "heatwave"],
];

function timestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

function insideBbox(coordinates, bbox) {
  return coordinates[0] >= bbox[0] && coordinates[0] <= bbox[2]
    && coordinates[1] >= bbox[1] && coordinates[1] <= bbox[3];
}

function titleCase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b\p{L}/gu, letter => letter.toUpperCase());
}

function formatNifcLocation(value, stateCode) {
  const stateName = FEMA_STATE_NAMES[stateCode] || stateCode;
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  const withoutState = cleaned.replace(new RegExp(`,?\\s*${stateCode}$`, "i"), "").trim();
  const match = withoutState.match(/^(\d+(?:\.\d+)?)\s+miles?\s+([NSEW]{1,3})\s+from\s+(.+)$/i);
  if (!match) return cleaned || stateName;
  const directions = {
    N: "north", NE: "northeast", E: "east", SE: "southeast",
    S: "south", SW: "southwest", W: "west", NW: "northwest",
  };
  const direction = directions[match[2].toUpperCase()] || match[2].toLowerCase();
  const place = titleCase(match[3]);
  return `${match[1]} miles ${direction} of ${place}${stateName ? `, ${stateName}` : ""}`;
}

export function classifyFemaIncident(value) {
  return FEMA_INCIDENT_TYPES.find(([pattern]) => pattern.test(String(value || "")))?.[1] || null;
}

export function buildFemaFeatures(rows, { cutoffMs, bbox, centersByDisaster = new Map() }) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = String(row.disasterNumber || "");
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const features = [];
  for (const declarationRows of groups.values()) {
    const declaration = declarationRows[0];
    const hazard = classifyFemaIncident(declaration.incidentType || declaration.declarationTitle);
    const disasterNumber = Number(declaration.disasterNumber);
    const declaredAreaCenter = centersByDisaster.get(disasterNumber);
    const coordinates = declaredAreaCenter || FEMA_STATE_CENTERS[String(declaration.state || "").toUpperCase()];
    const declarationAt = timestamp(declaration.declarationDate);
    if (!hazard || !coordinates || declarationAt < cutoffMs || !insideBbox(coordinates, bbox)) continue;

    const designatedAreas = [...new Set(declarationRows.map(row => row.designatedArea).filter(Boolean))];
    const declarationType = String(declaration.declarationType || "").toUpperCase();
    const stateCode = String(declaration.state || "").toUpperCase();
    const stateName = FEMA_STATE_NAMES[stateCode] || stateCode;
    const incidentEndedAt = declaration.incidentEndDate ? new Date(declaration.incidentEndDate).toISOString() : null;
    const assistance = [];
    if (declarationRows.some(row => row.ihProgramDeclared || row.iaProgramDeclared)) assistance.push("individual assistance");
    if (declarationRows.some(row => row.paProgramDeclared)) assistance.push("public assistance");
    if (declarationRows.some(row => row.hmProgramDeclared)) assistance.push("hazard mitigation");
    const declarationLabel = declarationType === "FM" ? "Fire Management Assistance declaration"
      : declarationType === "EM" ? "federal emergency declaration"
        : "major disaster declaration";

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [...coordinates] },
      properties: {
        hazard,
        severity: declarationType === "DR" || assistance.includes("individual assistance") ? "high" : "medium",
        confidence: "confirmed",
        title: `${titleCase(declaration.declarationTitle || declaration.incidentType)} — ${stateName}`,
        notes: [
          `FEMA ${declarationLabel} ${declaration.femaDeclarationString || declaration.disasterNumber} confirms an official response in ${stateName}.`,
          `${designatedAreas.length} designated area${designatedAreas.length === 1 ? "" : "s"}${designatedAreas.length ? `: ${designatedAreas.slice(0, 8).join(", ")}${designatedAreas.length > 8 ? ` and ${designatedAreas.length - 8} more` : ""}` : ""}.`,
          assistance.length ? `Approved programs include ${assistance.join(", ")}.` : "",
          incidentEndedAt ? `The incident period ended ${incidentEndedAt.slice(0, 10)}; the federal declaration is newer and remains within Alertly's 15-day response window.` : "The incident period is still open in FEMA's record.",
          declaredAreaCenter
            ? `Location: center of FEMA's designated-area geometry; open the declaration for its exact boundaries.`
            : `Location: state or territory center; open FEMA's declaration for the exact designated areas.`,
        ].filter(Boolean).join(" "),
        automated: true,
        source: "fema",
        sourceType: "official disaster declaration",
        sourceUrl: `https://www.fema.gov/disaster/${declaration.disasterNumber}`,
        extId: `fema_${declaration.disasterNumber}`,
        femaDeclarationVerified: true,
        declarationType,
        stateCode,
        designatedAreas,
        locationLabel: designatedAreas.length
          ? `${designatedAreas.slice(0, 3).join(", ")}${designatedAreas.length > 3 ? ` and ${designatedAreas.length - 3} more` : ""}, ${stateName}`
          : stateName,
        locationEstimated: true,
        detectedAt: new Date(declaration.incidentBeginDate || declaration.declarationDate).toISOString(),
        lastUpdatedAt: new Date(declaration.declarationDate).toISOString(),
        createdAt: new Date(declaration.declarationDate).toISOString(),
      },
    });
  }
  return features;
}

export function buildNifcFeatures(records, { cutoffMs, bbox }) {
  const features = [];
  for (const record of records || []) {
    const properties = record?.properties || {};
    const coordinates = record?.geometry?.coordinates?.slice(0, 2).map(Number);
    const updatedAt = timestamp(properties.ModifiedOnDateTime_dt);
    const acres = Math.max(0, Number(properties.IncidentSize) || 0);
    const personnel = Math.max(0, Number(properties.TotalIncidentPersonnel) || 0);
    const contained = Math.max(0, Number(properties.PercentContained) || 0);
    if (String(properties.IncidentTypeCategory || "").toUpperCase() !== "WF") continue;
    if (!coordinates || !coordinates.every(Number.isFinite) || !insideBbox(coordinates, bbox)) continue;
    if (properties.FireOutDateTime || updatedAt < cutoffMs || contained >= 80) continue;
    if (acres < 1_000 && personnel < 100) continue;

    const incidentId = String(properties.IrwinID || properties.UniqueFireIdentifier || properties.GlobalID || "")
      .replace(/[{}]/g, "");
    if (!incidentId) continue;
    const name = String(properties.IncidentName || "Unnamed").trim();
    const discoveryAt = timestamp(properties.FireDiscoveryDateTime);
    const stateCode = String(properties.POOState || "").replace(/^US-/, "");
    const stateName = FEMA_STATE_NAMES[stateCode] || stateCode || "the reported area";
    const locationLabel = formatNifcLocation(properties.IncidentShortDescription, stateCode);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates },
      properties: {
        hazard: "fire",
        severity: acres >= 10_000 || personnel >= 100 ? "high" : "medium",
        confidence: "confirmed",
        title: `${titleCase(name)} Wildfire`,
        notes: [
          `An active wildfire in ${stateName} has burned ${Math.round(acres).toLocaleString("en-US")} acres and is ${contained}% contained.`,
          personnel ? `${personnel.toLocaleString("en-US")} incident personnel ${personnel === 1 ? "is" : "are"} assigned to the response.` : "",
          `This is a current operational incident reported by NIFC/IRWIN.`,
        ].filter(Boolean).join(" "),
        automated: true,
        source: "nifc_irwin",
        sourceType: "official wildfire operations feed",
        sourceUrl: "https://www.arcgis.com/home/item.html?id=4181a117dc9e43db8598533e29972015",
        extId: `nifc_${incidentId}`,
        nifcOperationalIncident: true,
        acres,
        percentContained: contained,
        incidentPersonnel: personnel,
        stateCode,
        locationLabel,
        locationEstimated: false,
        detectedAt: new Date(Number.isFinite(discoveryAt) ? discoveryAt : updatedAt).toISOString(),
        lastUpdatedAt: new Date(updatedAt).toISOString(),
        createdAt: new Date(Number.isFinite(discoveryAt) ? discoveryAt : updatedAt).toISOString(),
      },
    });
  }
  return features;
}
