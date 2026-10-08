const VOLCANO_LOCATIONS = [
  {
    aliases: ["fuego", "el fuego", "volcan de fuego", "volcán de fuego"],
    coordinates: [-90.8806, 14.4748],
    source: "Smithsonian Global Volcanism Program",
  },
];

export function resolveCopernicusEventLocation({ hazard, title, areaNames = [], providerCoordinates }) {
  const fallback = {
    coordinates: providerCoordinates,
    estimated: true,
    source: "Copernicus activation center",
  };
  if (hazard !== "volcano") return fallback;

  const labels = [title, ...areaNames].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  const volcano = VOLCANO_LOCATIONS.find((entry) =>
    entry.aliases.some((alias) => labels.some((label) => label === alias || label.includes(`volcano ${alias}`)))
  );
  if (!volcano) return fallback;
  return {
    coordinates: [...volcano.coordinates],
    estimated: false,
    source: volcano.source,
  };
}
