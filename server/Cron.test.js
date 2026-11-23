const Cron = require('./Cron');
const wib = require('./wib');

// 2026-11-24 08:00:00 WIB, a Tuesday.
const NOW = Date.UTC(2026, 10, 24, 1, 0, 0);

describe('parse', () => {
  it('expands ranges, lists and steps', () => {
    const spec = Cron.parse('*/15 9-17 1,15 * 1-5');

    expect(spec.minutes).toEqual([0, 15, 30, 45]);
    expect(spec.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(spec.days).toEqual([1, 15]);
    expect(spec.months).toHaveLength(12);
    expect(spec.weekdays).toEqual([1, 2, 3, 4, 5]);
  });

  it('treats both 0 and 7 as Sunday', () => {
    expect(Cron.parse('0 0 * * 7').weekdays).toEqual([0]);
    expect(Cron.parse('0 0 * * 0').weekdays).toEqual([0]);
  });

  it('accepts month and weekday names', () => {
    expect(Cron.parse('0 0 1 jan mon').months).toEqual([1]);
    expect(Cron.parse('0 0 1 jan mon').weekdays).toEqual([1]);
  });

  it('accepts the @macros', () => {
    expect(Cron.parse('@daily').hours).toEqual([0]);
    expect(Cron.parse('@hourly').minutes).toEqual([0]);
  });

  it('rejects a field count that is not five', () => {
    expect(() => Cron.parse('* * *')).toThrow(/5 fields/);
  });

  it('rejects out-of-range values, reversed ranges and bad steps', () => {
    expect(() => Cron.parse('60 * * * *')).toThrow(/minute field must stay within 0-59/);
    expect(() => Cron.parse('* 24 * * *')).toThrow(/hour field must stay within 0-23/);
    expect(() => Cron.parse('* * 0 * *')).toThrow(/day-of-month field must stay within 1-31/);
    expect(() => Cron.parse('* * * 13 *')).toThrow(/month field must stay within 1-12/);
    expect(() => Cron.parse('5-1 * * * *')).toThrow(/starts after it ends/);
    expect(() => Cron.parse('*/0 * * * *')).toThrow(/Invalid step/);
    expect(() => Cron.parse('a * * * *')).toThrow(/Invalid value "a"/);
    expect(() => Cron.parse('')).toThrow(/empty/);
  });
});

describe('nextRun', () => {
  it('finds the next daily time in WIB, not the host timezone', () => {
    const next = Cron.nextRun('0 8 * * *', NOW);

    expect(wib.formatFull(next)).toBe('25 Nov 2026, 08:00:00 WIB');
  });

  it('finds a slot later on the same day', () => {
    const next = Cron.nextRun('30 8 * * *', NOW);

    expect(wib.formatFull(next)).toBe('24 Nov 2026, 08:30:00 WIB');
  });

  it('honours a step inside the hour', () => {
    const next = Cron.nextRun('*/15 * * * *', NOW);

    expect(wib.formatFull(next)).toBe('24 Nov 2026, 08:15:00 WIB');
  });

  it('skips to the next weekday for a weekday-only schedule', () => {
    // Friday 20:00 WIB -> next run Monday 09:00.
    const friday = Date.UTC(2026, 10, 27, 13, 0, 0);
    const next = Cron.nextRun('0 9 * * 1-5', friday);

    expect(wib.formatFull(next)).toBe('30 Nov 2026, 09:00:00 WIB');
  });

  it('treats a restricted day-of-month and day-of-week as OR (Vixie cron)', () => {
    // 1st of the month OR Monday: Monday 30 Nov comes before 1 Dec.
    const first = Cron.nextRun('0 12 1 * 1', Date.UTC(2026, 10, 24, 1, 0, 0));
    const second = Cron.nextRun('0 12 1 * 1', first);

    expect(wib.formatFull(first)).toBe('30 Nov 2026, 12:00:00 WIB');
    expect(wib.formatFull(second)).toBe('01 Des 2026, 12:00:00 WIB');
  });

  it('returns null for a date that never comes', () => {
    expect(Cron.nextRun('0 0 31 2 *', NOW)).toBeNull();
  });

  it('is strictly after the given instant', () => {
    const at = Cron.nextRun('0 8 * * *', NOW - 1);
    const again = Cron.nextRun('0 8 * * *', at);

    expect(wib.formatFull(at)).toBe('24 Nov 2026, 08:00:00 WIB');
    expect(wib.formatFull(again)).toBe('25 Nov 2026, 08:00:00 WIB');
  });
});

describe('describe', () => {
  it('reads a daily time', () => {
    expect(Cron.describe('0 8 * * *')).toBe('Setiap hari pukul 08:00');
  });

  it('reads an interval', () => {
    expect(Cron.describe('*/15 * * * *')).toBe('Setiap 15 menit');
    expect(Cron.describe('*/5 * * * *')).toBe('Setiap 5 menit');
  });

  it('reads weekdays, weekends and single days', () => {
    expect(Cron.describe('0 9 * * 1-5')).toBe('Setiap hari kerja (Senin–Jumat) pukul 09:00');
    expect(Cron.describe('0 9 * * 0,6')).toBe('Setiap akhir pekan (Sabtu–Minggu) pukul 09:00');
    expect(Cron.describe('0 9 * * mon')).toBe('Setiap Senin pukul 09:00');
  });

  it('reads days of the month', () => {
    expect(Cron.describe('0 22 1,15 * *')).toBe('Tanggal 1 dan 15 setiap bulan pukul 22:00');
  });

  it('reads every minute and every hour', () => {
    expect(Cron.describe('* * * * *')).toBe('Setiap menit');
    expect(Cron.describe('0 * * * *')).toBe('Setiap hari, setiap jam pada menit 0');
  });

  it('throws on a malformed expression rather than inventing a reading', () => {
    expect(() => Cron.describe('0 25 * * *')).toThrow(/hour field/);
  });
});
