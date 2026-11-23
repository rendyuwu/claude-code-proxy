'use strict';

const wib = require('./wib');

// Standard five-field cron (minute hour day-of-month month day-of-week),
// evaluated in WIB (UTC+7, no DST). Every notification this proxy sends is
// stamped with Asia/Jakarta time, so "0 8 * * *" has to mean 08:00 Jakarta
// even on a container whose system clock is UTC.
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// A schedule that only matches a leap day (29 February) still resolves — every
// eight years at worst, since 2100 is not a leap year — and an impossible one
// (31 February) is reported as "never" instead of looping. Only day-level work
// happens per iteration, so ten years is a few thousand cheap checks.
const MAX_SEARCH_DAYS = 366 * 10;

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};
const MONTH_LABELS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DOW_LABELS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *'
};

const pad2 = (value) => String(value).padStart(2, '0');

const joinIndonesian = (items) => {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} dan ${items[items.length - 1]}`;
};

// Build one field's set of values. stepText with no range means "from start to
// the field maximum", matching Vixie cron ("5/10" is 5,15,25,...).
const buildField = (raw, { min, max, field, names = null, normalize = (value) => value }) => {
  const parseValue = (token) => {
    const text = token.trim();
    if (/^\d+$/.test(text)) return Number(text);
    const named = names ? names[text] : undefined;
    if (named !== undefined) return named;
    throw new Error(`Invalid value "${token}" in ${field} field`);
  };

  const values = new Set();
  for (const part of raw.split(',')) {
    if (!part) throw new Error(`Empty item in ${field} field`);

    const pieces = part.split('/');
    if (pieces.length > 2) throw new Error(`Only one step is allowed in ${field} field: "${part}"`);
    const [rangeText, stepText] = pieces;

    let step = 1;
    if (stepText !== undefined) {
      step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`Invalid step "${stepText}" in ${field} field`);
      }
    }

    let start;
    let end;
    if (rangeText === '*') {
      start = min;
      end = max;
    } else if (rangeText.includes('-')) {
      const [startText, endText] = rangeText.split('-');
      if (!startText || !endText) throw new Error(`Invalid range "${part}" in ${field} field`);
      start = parseValue(startText);
      end = parseValue(endText);
      if (start > end) throw new Error(`Range starts after it ends in ${field} field: "${part}"`);
    } else {
      start = parseValue(rangeText);
      end = stepText === undefined ? start : max;
    }

    if (start < min || end > max) {
      throw new Error(`${field} field must stay within ${min}-${max}: "${part}"`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(normalize(value));
    }
  }

  return [...values].sort((a, b) => a - b);
};

/**
 * @param {string} expression five fields, or an @macro
 * @returns {{minutes:number[], hours:number[], days:number[], months:number[],
 *   weekdays:number[], domWildcard:boolean, dowWildcard:boolean,
 *   expression:string}} throws on malformed input
 */
const parse = (expression) => {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new Error('Cron expression is empty');
  }

  const trimmed = expression.trim().toLowerCase();
  const expanded = MACROS[trimmed] || trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`
    );
  }

  const [minuteText, hourText, domText, monthText, dowText] = fields;

  return {
    expression: trimmed,
    minutes: buildField(minuteText, { min: 0, max: 59, field: 'minute' }),
    hours: buildField(hourText, { min: 0, max: 23, field: 'hour' }),
    days: buildField(domText, { min: 1, max: 31, field: 'day-of-month' }),
    months: buildField(monthText, { min: 1, max: 12, field: 'month', names: MONTH_NAMES }),
    weekdays: buildField(dowText, {
      min: 0,
      max: 7,
      field: 'day-of-week',
      names: DOW_NAMES,
      // cron accepts both 0 and 7 for Sunday.
      normalize: (value) => (value === 7 ? 0 : value)
    }),
    domWildcard: domText === '*',
    dowWildcard: dowText === '*'
  };
};

// Vixie cron semantics: when both day fields are restricted, a day matches if
// either does (that is why "0 0 1 * 1" is "the 1st OR any Monday").
const dayMatches = (spec, parts) => {
  const domOk = spec.days.includes(parts.day);
  const dowOk = spec.weekdays.includes(parts.weekday);
  if (!spec.domWildcard && !spec.dowWildcard) return domOk || dowOk;
  if (!spec.domWildcard) return domOk;
  if (!spec.dowWildcard) return dowOk;
  return true;
};

/**
 * First scheduled minute strictly after afterMs.
 * @param {string} expression
 * @param {number} afterMs
 * @returns {number|null} epoch ms in WIB terms, or null when the expression
 *   never matches within five years
 */
const nextRun = (expression, afterMs = Date.now()) => {
  const spec = parse(expression);

  const from = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  // Start of the WIB day that contains `from`, so hours and minutes can be
  // added to a fixed midnight instead of scanning every minute.
  const firstDayStart = Math.floor((from + wib.WIB_OFFSET_MS) / DAY_MS) * DAY_MS - wib.WIB_OFFSET_MS;

  for (let dayIndex = 0; dayIndex < MAX_SEARCH_DAYS; dayIndex += 1) {
    const dayStart = firstDayStart + dayIndex * DAY_MS;
    // Noon is always inside this WIB day, so its month and weekday are the
    // day's own regardless of any host timezone.
    const parts = wib.parts(dayStart + 12 * 60 * 60 * 1000);
    if (!spec.months.includes(parts.month)) continue;
    if (!dayMatches(spec, parts)) continue;

    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const candidate = dayStart + hour * 60 * 60 * 1000 + minute * MINUTE_MS;
        if (candidate >= from) return candidate;
      }
    }
  }

  return null;
};

const fullRange = (values, min, max) => values.length === max - min + 1;

// Common minute interval like "*/5" -> 5. Anything else -> null.
const stepOf = (values) => {
  if (values.length < 2 || values[0] !== 0) return null;
  const step = values[1] - values[0];
  if (step < 1) return null;
  if (values.length !== Math.floor(59 / step) + 1) return null;
  return values.every((value, index) => value === index * step) ? step : null;
};

const dayPhrase = (spec, domEvery, dowEvery) => {
  if (domEvery && dowEvery) return 'Setiap hari';
  if (domEvery) {
    const weekdays = spec.weekdays;
    if (weekdays.length === 7) return 'Setiap hari';
    if (weekdays.length === 5 && [1, 2, 3, 4, 5].every(day => weekdays.includes(day))) {
      return 'Setiap hari kerja (Senin–Jumat)';
    }
    if (weekdays.length === 2 && weekdays.includes(0) && weekdays.includes(6)) {
      return 'Setiap akhir pekan (Sabtu–Minggu)';
    }
    return `Setiap ${joinIndonesian(weekdays.map(day => DOW_LABELS[day]))}`;
  }
  if (dowEvery) {
    return `Tanggal ${joinIndonesian(spec.days.map(String))} setiap bulan`;
  }
  return `Tanggal ${joinIndonesian(spec.days.map(String))} atau setiap `
    + joinIndonesian(spec.weekdays.map(day => DOW_LABELS[day]));
};

const timePhrase = (spec, minuteEvery, hourEvery) => {
  if (minuteEvery && hourEvery) return 'setiap menit';
  if (hourEvery) {
    return `setiap jam pada menit ${joinIndonesian(spec.minutes.map(String))}`;
  }
  if (minuteEvery) {
    return `setiap menit selama jam ${joinIndonesian(spec.hours.map(hour => pad2(hour)))}`;
  }

  const times = [];
  for (const hour of spec.hours) {
    for (const minute of spec.minutes) {
      times.push(`${pad2(hour)}:${pad2(minute)}`);
    }
  }
  if (times.length <= 8) return `pukul ${joinIndonesian(times)}`;

  return `pada menit ${joinIndonesian(spec.minutes.map(String))} di jam `
    + joinIndonesian(spec.hours.map(hour => pad2(hour)));
};

/**
 * Human-readable Indonesian description of a cron expression, for the field
 * the user types it into. Times are WIB.
 * @param {string} expression
 * @returns {string}
 */
const describe = (expression) => {
  const spec = parse(expression);

  const minuteEvery = fullRange(spec.minutes, 0, 59);
  const hourEvery = fullRange(spec.hours, 0, 23);
  const monthEvery = fullRange(spec.months, 1, 12);
  const domEvery = fullRange(spec.days, 1, 31);
  const dowEvery = spec.weekdays.length === 7;

  if (minuteEvery && hourEvery && domEvery && dowEvery && monthEvery) return 'Setiap menit';

  // "*/5 * * * *" and friends read far better as an interval than as a list of
  // times, and they are the shapes people actually type.
  const step = stepOf(spec.minutes);
  if (step !== null && hourEvery && domEvery && dowEvery && monthEvery) {
    return `Setiap ${step} menit`;
  }

  let day = dayPhrase(spec, domEvery, dowEvery);
  // A fixed month replaces "setiap bulan" instead of stacking on top of it.
  if (!monthEvery) {
    const months = `bulan ${joinIndonesian(spec.months.map(month => MONTH_LABELS[month - 1]))}`;
    day = day === 'Setiap hari'
      ? `Setiap hari di ${months}`
      : day.replace(' setiap bulan', '') + ` ${months}`;
  }

  const time = timePhrase(spec, minuteEvery, hourEvery);
  // "Setiap hari setiap jam ..." needs a separator; "Setiap hari pukul 08:00"
  // does not.
  const joiner = time.startsWith('pukul') || time.startsWith('pada') ? ' ' : ', ';

  return `${day}${joiner}${time}`;
};

module.exports = { parse, nextRun, describe };
