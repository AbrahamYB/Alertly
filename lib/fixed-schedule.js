const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function parseDailyTimes(value = "00:00,12:00") {
  const times = [...new Set(String(value).split(",").map(item => item.trim()).filter(Boolean))];
  if (!times.length || times.some(time => !TIME_PATTERN.test(time))) {
    throw new TypeError("Scheduled times must be comma-separated 24-hour values such as 00:00,12:00.");
  }
  return times.sort();
}

export function zonedMinute(date, timeZone = "America/Guatemala") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return {
    time: `${parts.hour}:${parts.minute}`,
    key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`,
  };
}

export function nextScheduledTime(from = new Date(), { times = ["00:00", "12:00"], timeZone = "America/Guatemala" } = {}) {
  const normalizedTimes = new Set(Array.isArray(times) ? times : parseDailyTimes(times));
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  for (let minute = 0; minute <= 48 * 60; minute += 1) {
    if (normalizedTimes.has(zonedMinute(cursor, timeZone).time)) return new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error("Could not calculate the next scheduled hazard refresh.");
}
