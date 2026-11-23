const wib = require('./wib');

describe('parts', () => {
  it('shifts the epoch into WIB without depending on the host timezone', () => {
    // 03:00 UTC is 10:00 WIB.
    expect(wib.parts(Date.UTC(2026, 10, 22, 3, 0, 0))).toEqual({
      year: 2026,
      month: 11,
      day: 22,
      weekday: 0,
      hour: 10,
      minute: 0,
      second: 0
    });
  });

  it('rolls the date over past 17:00 UTC', () => {
    const p = wib.parts(Date.UTC(2026, 10, 22, 17, 30, 0));

    expect(p.day).toBe(23);
    expect(p.hour).toBe(0);
    expect(p.minute).toBe(30);
  });
});

describe('formatFull', () => {
  it('renders the auto-ping style timestamp', () => {
    expect(wib.formatFull(Date.UTC(2026, 10, 22, 3, 0, 0)))
      .toBe('22 Nov 2026, 10:00:00 WIB');
  });

  it('uses Indonesian month names', () => {
    expect(wib.formatFull(Date.UTC(2026, 7, 1, 0, 0, 0))).toContain('Agu');
    expect(wib.formatFull(Date.UTC(2026, 4, 1, 0, 0, 0))).toContain('Mei');
    expect(wib.formatFull(Date.UTC(2026, 11, 1, 0, 0, 0))).toContain('Des');
  });
});

describe('formatShort', () => {
  it('renders a weekday and time', () => {
    // Sunday 10:00 WIB.
    expect(wib.formatShort(Date.UTC(2026, 10, 22, 3, 0, 0))).toBe('Min 10:00');
  });
});

describe('formatRemaining', () => {
  it('matches the reference script units', () => {
    expect(wib.formatRemaining(0)).toBe('sekarang');
    expect(wib.formatRemaining(-1000)).toBe('sekarang');
    expect(wib.formatRemaining(90 * 1000)).toBe('2m');
    expect(wib.formatRemaining((5 * 60 + 12) * 60 * 1000)).toBe('5j 12m');
    expect(wib.formatRemaining((26 * 60 + 30) * 60 * 1000)).toBe('1h 2j');
  });
});
