const DIRECT_HAZARD_TYPES = new Map([
  ["earthquake", "earthquake"],
  ["fire", "fire"],
  ["wildfire", "fire"],
  ["flood", "flood"],
  ["pluvial/flash flood", "flood"],
  ["cyclone", "storm"],
  ["storm", "storm"],
  ["volcanic eruption", "volcano"],
  ["volcano", "volcano"],
  ["landslide", "landslide"],
  ["mudslide", "landslide"],
  ["drought", "drought"],
  ["heat wave", "heatwave"],
  ["extreme heat", "heatwave"],
]);

const INFERRED_HAZARDS = [
  [/earthquake|seismic/, "earthquake"],
  [/wildfire|forest fire|\bfire\b|burning of (?:houses|homes)/, "fire"],
  [/flood|inundat|overflow/, "flood"],
  [/cyclone|hurricane|typhoon|windstorm|severe storm|tropical storm/, "storm"],
  [/volcan|eruption|ash cloud/, "volcano"],
  [/landslide|mudslide|mass (?:movement|removal)|debris flow/, "landslide"],
  [/drought|water scarcity/, "drought"],
  [/heat wave|extreme heat/, "heatwave"],
];

const VERIFIED_IMPACT_PATTERN = /\b(?:damag(?:e|ed)|destroy(?:ed|s)|collaps(?:e|ed)|ravag(?:e|ed)|fatalit(?:y|ies)|(?:was|were|been) killed|(?:has|have|had) died|death(?:s)?|injur(?:y|ies|ed)|people affected|households affected|displaced|evacuat(?:ed|ion|ions)|shelter(?:ed|ing)|homes? (?:lost|burned|burnt|flooded)|buildings? (?:lost|burned|burnt|flooded)|infrastructure (?:failure|damage|disruption)|services? (?:were |was )?(?:interrupted|disrupted)|roads? (?:were |was )?(?:closed|blocked|damaged)|bridges? (?:were |was )?(?:closed|collapsed|damaged)|power (?:outage|failure)|water supply (?:was |were )?(?:interrupted|disrupted))\b/i;

const COUNT_FIELDS = ["dead", "injured", "missing", "affected", "displaced", "assisted"];

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function classifyIfrcHazard(event) {
  const direct = String(event?.dtype?.name || "").trim().toLowerCase();
  if (DIRECT_HAZARD_TYPES.has(direct)) return DIRECT_HAZARD_TYPES.get(direct);
  const searchable = String(event?.name || "").toLowerCase();
  return INFERRED_HAZARDS.find(([pattern]) => pattern.test(searchable))?.[1] || null;
}

export function latestPublicFieldReport(event) {
  return [...(event?.field_reports || [])]
    .filter(report => String(report?.visibility_display || "").toLowerCase() === "public")
    .sort((left, right) => new Date(right.updated_at || right.report_date || 0) - new Date(left.updated_at || left.report_date || 0))[0] || null;
}

export function extractIfrcImpactCounts(event, report) {
  const counts = {};
  for (const field of COUNT_FIELDS) {
    counts[field] = Math.max(
      numberOrZero(report?.[`num_${field}`]),
      numberOrZero(report?.[`gov_num_${field}`]),
      numberOrZero(report?.[`other_num_${field}`]),
      field === "affected" ? numberOrZero(event?.num_affected) : 0,
    );
  }
  return counts;
}

export function hasVerifiedIfrcImpact(counts, narrative) {
  return Object.values(counts || {}).some(value => Number(value) > 0)
    || VERIFIED_IMPACT_PATTERN.test(String(narrative || ""));
}

export function summarizeIfrcNarrative(narrative, maximumLength = 700) {
  const clean = String(narrative || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(sentence => sentence.trim()).filter(Boolean) || [clean];
  const impactful = sentences.filter(sentence => VERIFIED_IMPACT_PATTERN.test(sentence));
  const selected = (impactful.length ? impactful : sentences).slice(0, 3).join(" ");
  if (selected.length <= maximumLength) return selected;
  const shortened = selected.slice(0, maximumLength + 1);
  const sentenceEnd = Math.max(shortened.lastIndexOf("."), shortened.lastIndexOf("!"), shortened.lastIndexOf("?"));
  return sentenceEnd >= 200 ? shortened.slice(0, sentenceEnd + 1) : `${selected.slice(0, maximumLength).trimEnd()}…`;
}

export function formatIfrcImpactCounts(counts) {
  const labels = [
    ["dead", "dead"],
    ["injured", "injured"],
    ["missing", "missing"],
    ["affected", "affected"],
    ["displaced", "displaced"],
    ["assisted", "assisted"],
  ];
  return labels
    .filter(([field]) => Number(counts?.[field]) > 0)
    .map(([field, label]) => `${Number(counts[field]).toLocaleString("en-US")} ${label}`);
}

export function ifrcSeverity(event, counts) {
  const providerLevel = String(event?.ifrc_severity_level_display || "").toLowerCase();
  if (providerLevel === "red" || providerLevel === "orange") return "high";
  if (Number(counts?.dead) > 0 || Number(counts?.injured) >= 10 || Number(counts?.displaced) >= 1_000 || Number(counts?.affected) >= 10_000) return "high";
  return "medium";
}
