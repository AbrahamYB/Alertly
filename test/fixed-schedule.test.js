import test from "node:test";
import assert from "node:assert/strict";
import { nextScheduledTime, parseDailyTimes, zonedMinute } from "../lib/fixed-schedule.js";

test("fixed hazard schedule uses midnight and noon in Guatemala", () => {
  const options = { times: parseDailyTimes("00:00,12:00"), timeZone: "America/Guatemala" };
  assert.equal(nextScheduledTime(new Date("2026-10-07T05:00:00Z"), options).toISOString(), "2026-10-07T06:00:00.000Z");
  assert.equal(nextScheduledTime(new Date("2026-10-07T06:00:30Z"), options).toISOString(), "2026-10-07T06:00:00.000Z");
  assert.equal(nextScheduledTime(new Date("2026-10-07T06:01:00Z"), options).toISOString(), "2026-10-07T18:00:00.000Z");
  assert.equal(zonedMinute(new Date("2026-10-07T18:00:00Z"), options.timeZone).time, "12:00");
});

test("invalid fixed hazard times are rejected", () => {
  assert.throws(() => parseDailyTimes("12:00,25:00"), /24-hour values/);
});
