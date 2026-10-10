import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyIfrcHazard,
  extractIfrcImpactCounts,
  formatIfrcImpactCounts,
  hasVerifiedIfrcImpact,
  ifrcSeverity,
  latestPublicFieldReport,
  summarizeIfrcNarrative,
} from "../lib/ifrc-impact.js";

test("IFRC disaster types map to Alertly hazards without accepting unrelated crises", () => {
  assert.equal(classifyIfrcHazard({ dtype: { name: "Earthquake" } }), "earthquake");
  assert.equal(classifyIfrcHazard({ dtype: { name: "Pluvial/Flash Flood" } }), "flood");
  assert.equal(classifyIfrcHazard({ dtype: { name: "Other" }, name: "Severe storm and hail" }), "storm");
  assert.equal(classifyIfrcHazard({ dtype: { name: "Population Movement" }, name: "Protests and strikes" }), null);
  assert.equal(classifyIfrcHazard({ dtype: { name: "Epidemic" }, name: "Dengue outbreak" }), null);
});

test("the newest public field report supplies structured observed impacts", () => {
  const event = {
    num_affected: 80,
    field_reports: [
      { visibility_display: "Internal", updated_at: "2026-10-10T12:00:00Z", num_dead: 99 },
      { visibility_display: "Public", updated_at: "2026-10-09T12:00:00Z", num_affected: 50 },
      { visibility_display: "Public", updated_at: "2026-10-10T12:00:00Z", gov_num_dead: 2, other_num_injured: 7, num_displaced: 30 },
    ],
  };
  const report = latestPublicFieldReport(event);
  const counts = extractIfrcImpactCounts(event, report);
  assert.deepEqual(counts, { dead: 2, injured: 7, missing: 0, affected: 80, displaced: 30, assisted: 0 });
  assert.deepEqual(formatIfrcImpactCounts(counts), ["2 dead", "7 injured", "80 affected", "30 displaced"]);
  assert.equal(ifrcSeverity(event, counts), "high");
});

test("a marker requires reported consequences rather than detection or forecast text", () => {
  const empty = { dead: 0, injured: 0, missing: 0, affected: 0, displaced: 0, assisted: 0 };
  assert.equal(hasVerifiedIfrcImpact(empty, "An earthquake was detected and aftershocks are possible."), false);
  assert.equal(hasVerifiedIfrcImpact(empty, "Homes were damaged and residents were evacuated."), true);
  assert.equal(hasVerifiedIfrcImpact({ ...empty, affected: 12 }, ""), true);
});

test("descriptions select complete impact sentences instead of dumping field reports", () => {
  const summary = summarizeIfrcNarrative("Heavy rain was forecast. Seven homes were damaged. Roads were blocked by debris. Teams continue monitoring the forecast.");
  assert.equal(summary, "Seven homes were damaged. Roads were blocked by debris.");
});
