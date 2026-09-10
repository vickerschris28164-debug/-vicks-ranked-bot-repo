const WEEKDAY_MAP = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

function parseWeekdayList(value) {
  if (!value || typeof value !== 'string') return [];
  const ids = new Set();

  for (const token of value.split(/[\s,]+/)) {
    const raw = token.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    const mapped = WEEKDAY_MAP[key];
    if (mapped !== undefined) ids.add(mapped);
  }

  return [...ids].sort((a, b) => a - b);
}

function timeStringToMinutes(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return hour * 60 + minute;
}

function computeNextOccurrence(fromMs, weekdays, timeValue) {
  if (!Array.isArray(weekdays) || weekdays.length === 0) return null;
  const timeMinutes = timeStringToMinutes(timeValue);
  if (timeMinutes === null) return null;

  const start = new Date(fromMs);
  const targetDaySet = new Set(weekdays.map((day) => Number(day) % 7));

  for (let offset = 0; offset < 14; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 24 * 60 * 60 * 1000);
    const weekday = candidate.getUTCDay();

    if (!targetDaySet.has(weekday)) continue;

    const candidateMs = Date.UTC(
      candidate.getUTCFullYear(),
      candidate.getUTCMonth(),
      candidate.getUTCDate(),
      Math.floor(timeMinutes / 60),
      timeMinutes % 60,
      0,
      0,
    );

    if (candidateMs > fromMs) return candidateMs;
  }

  return null;
}

module.exports = {
  parseWeekdayList,
  computeNextOccurrence,
  timeStringToMinutes,
};
