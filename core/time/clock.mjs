const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

function validDate(value, name = "time") {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid date`);
  return date;
}

function dateKey(date, timeZone = SHANGHAI_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function createClock({ now = () => new Date() } = {}) {
  const current = () => validDate(typeof now === "function" ? now() : now, "clock now");
  return Object.freeze({
    timeZone: SHANGHAI_TIME_ZONE,
    utcNow: current,
    shanghaiNow() {
      const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: SHANGHAI_TIME_ZONE,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23",
      }).format(current());
      return new Date(`${parts.replace(" ", "T")}+08:00`);
    },
    shanghaiDate(value = current()) {
      return dateKey(validDate(value));
    },
    sleepBusinessDate(value = current()) {
      const shifted = new Date(validDate(value).getTime() - 6 * 60 * 60 * 1000);
      return dateKey(shifted);
    },
  });
}

export { SHANGHAI_TIME_ZONE };
