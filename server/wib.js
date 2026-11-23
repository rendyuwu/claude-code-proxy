'use strict';

// Every timestamp the limit messages carry is Asia/Jakarta time, and WIB has
// no DST, so a fixed +7h offset is exact. Doing the arithmetic on the epoch
// avoids depending on full ICU data (a Docker image without it made
// Intl.DateTimeFormat throw) and makes the output identical on every host,
// whatever its system timezone.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
// Sunday first: Date#getUTCDay order.
const WEEKDAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

const pad2 = (value) => String(value).padStart(2, '0');

/**
 * @param {number} atMs
 * @returns {{year:number, month:number, day:number, weekday:number,
 *   hour:number, minute:number, second:number}} fields in WIB
 */
const parts = (atMs) => {
  const date = new Date(Number(atMs) + WIB_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds()
  };
};

/**
 * @param {number} atMs
 * @returns {string} e.g. "22 Nov 2026, 10:00:00 WIB"
 */
const formatFull = (atMs) => {
  const p = parts(atMs);
  return `${pad2(p.day)} ${MONTHS[p.month - 1]} ${p.year}, `
    + `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)} WIB`;
};

/**
 * @param {number} atMs
 * @returns {string} e.g. "Sen 10:00" (no zone suffix; callers add " WIB")
 */
const formatShort = (atMs) => {
  const p = parts(atMs);
  return `${WEEKDAYS[p.weekday]} ${pad2(p.hour)}:${pad2(p.minute)}`;
};

/**
 * Countdown wording, matching the reference limit script: "sekarang",
 * "1h 3j" (1 day 3 hours), "5j 12m" (5 hours 12 minutes), "3m".
 * @param {number} ms remaining
 * @returns {string}
 */
const formatRemaining = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return 'sekarang';
  if (ms >= 24 * 60 * 60 * 1000) {
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    return `${days}h ${hours}j`;
  }
  if (ms >= 60 * 60 * 1000) {
    const hours = Math.floor(ms / (60 * 60 * 1000));
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
    return `${hours}j ${minutes}m`;
  }
  return `${Math.ceil(ms / (60 * 1000))}m`;
};

module.exports = { WIB_OFFSET_MS, parts, formatFull, formatShort, formatRemaining };
