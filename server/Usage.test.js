const Usage = require('./Usage');
const wib = require('./wib');

// Trimmed copy of a real /api/oauth/usage body: limits[] plus the legacy
// top-level objects the reference script reads dollars from.
const body = () => ({
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 95,
      severity: 'critical',
      resets_at: '2026-11-22T17:00:00.316187+00:00',
      scope: null,
      is_active: false
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 46,
      severity: 'normal',
      resets_at: '2026-11-23T01:00:00.316209+00:00',
      scope: null,
      is_active: true
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 89,
      severity: 'warning',
      resets_at: '2026-11-23T01:00:00.316209+00:00',
      scope: { model: { display_name: 'Opus' } },
      is_active: false
    }
  ],
  five_hour: { utilization: 95, resets_at: '2026-11-22T17:00:00.316187+00:00', used_dollars: 1.25, limit_dollars: 5 },
  seven_day: { utilization: 46, resets_at: '2026-11-23T01:00:00.316209+00:00' },
  spend: {
    enabled: true,
    percent: 20,
    used: { amount_minor: 250, exponent: 2, currency: 'USD' },
    limit: { amount_minor: 1000, exponent: 2 },
    balance: { amount_minor: 750, exponent: 2 }
  },
  extra_usage: { spend_limit_reached: false }
});

const account = { id: 'a1', label: 'budi@example.com', email: 'budi@example.com' };

describe('normalize', () => {
  it('reads the limits array', () => {
    const usage = Usage.normalize(body());

    expect(usage.limits).toHaveLength(3);
    expect(usage.limits[0]).toMatchObject({ kind: 'session', percent: 95, severity: 'critical' });
    expect(usage.limits[0].resetsAt).toBe(Date.parse('2026-11-22T17:00:00.316187+00:00'));
    expect(usage.limits[1].isActive).toBe(true);
  });

  it('falls back to the legacy top-level objects', () => {
    const usage = Usage.normalize({
      five_hour: { utilization: 31, resets_at: '2026-11-22T17:00:00+00:00' },
      seven_day: { utilization: 46, resets_at: '2026-11-23T01:00:00+00:00' }
    });

    expect(usage.limits.map(limit => [limit.kind, limit.percent]))
      .toEqual([['session', 31], ['weekly_all', 46]]);
  });

  it('returns null when nothing usable is there', () => {
    expect(Usage.normalize(null)).toBeNull();
    expect(Usage.normalize({})).toBeNull();
    expect(Usage.normalize({ limits: [] })).toBeNull();
  });

  it('skips entries without a numeric percent', () => {
    const usage = Usage.normalize({
      limits: [{ kind: 'session' }, { kind: 'session', percent: 'nope' }, { kind: 'weekly_all', percent: 3 }]
    });

    expect(usage.limits).toHaveLength(1);
    expect(usage.limits[0].kind).toBe('weekly_all');
  });
});

describe('formatAccountUsage', () => {
  const now = Date.parse('2026-11-22T16:00:00+00:00');

  it('names the account above the reference-script block', () => {
    const text = Usage.formatAccountUsage(account, Usage.normalize(body()), { active: true, now });
    const [first] = text.split('\n');

    expect(first).toBe('Akun: budi@example.com [aktif]');
  });

  it('renders limits, bars, resets and the reset countdown', () => {
    const text = Usage.formatAccountUsage(account, Usage.normalize(body()), { now });
    const lines = text.split('\n');

    expect(lines[1]).toContain('5 jam');
    expect(lines[1]).toContain('██████████');
    expect(lines[1]).toContain(' 95% ‼');
    expect(lines[1]).toContain('reset Sen 00:00');
    expect(lines[1]).toContain('(1j 0m)');
    expect(lines[1]).toContain('$1.25/$5');
    expect(lines[2]).toContain('7 hari');
    expect(lines[2]).toContain('←');
    expect(lines[3]).toContain('7h Opus');
  });

  it('renders the credit line like the reference script', () => {
    const text = Usage.formatAccountUsage(account, Usage.normalize(body()), { now });

    expect(text).toContain('Kredit    ██░░░░░░░░   20%    $2.5 / $10  sisa $7.5');
  });

  it('says when a window was never used instead of a reset time', () => {
    const usage = Usage.normalize({ limits: [{ kind: 'session', percent: 0, severity: 'normal' }] });

    expect(Usage.formatAccountUsage(account, usage)).toContain('belum terpakai');
  });
});

describe('lowLimits', () => {
  it('selects the windows at or past the used threshold', () => {
    const usage = Usage.normalize(body());

    // 10% left is 90% used: only the session window (95%) qualifies.
    expect(Usage.lowLimits(usage, 10).map(limit => limit.kind)).toEqual(['session']);
    // 5% left is 95% used, the boundary of the same window.
    expect(Usage.lowLimits(usage, 5).map(limit => limit.kind)).toEqual(['session']);
    // A wider threshold takes the weekly windows too.
    expect(Usage.lowLimits(usage, 55).map(limit => limit.kind))
      .toEqual(['session', 'weekly_all', 'weekly_scoped']);
    expect(Usage.lowLimits(usage, 1)).toEqual([]);
  });

  it('ignores kinds that are not a 5-hour or 7-day window', () => {
    const usage = Usage.normalize({
      limits: [
        { kind: 'promo_credits', percent: 99 },
        { kind: 'weekly_cowork', percent: 95 }
      ]
    });

    expect(Usage.lowLimits(usage, 10).map(limit => limit.kind)).toEqual(['weekly_cowork']);
  });
});

describe('limitKey', () => {
  it('separates a scoped limit from the overall one', () => {
    const usage = Usage.normalize(body());

    expect(Usage.limitKey(usage.limits[1])).toBe('weekly_all:');
    expect(Usage.limitKey(usage.limits[2])).toBe('weekly_scoped:Opus');
  });
});

describe('formatLowLimitAlert', () => {
  const now = Date.parse('2026-11-22T16:00:00+00:00');

  it('names the account, the window and what is left', () => {
    const usage = Usage.normalize(body());
    const text = Usage.formatLowLimitAlert(account, usage.limits[0], { now, active: true });
    const lines = text.split('\n');

    expect(lines[0]).toBe('‼ Limit menipis: 5 jam sisa 5%');
    expect(lines[1]).toBe('Akun: budi@example.com [aktif]');
    expect(lines[2]).toContain('5 jam');
    expect(lines[2]).toContain(' 95% ‼');
    expect(lines[2]).toContain('reset 23 Nov 2026, 00:00:00 WIB (sisa 1j 0m)');
  });

  it('uses the scoped model name so two weekly windows are distinguishable', () => {
    const usage = Usage.normalize(body());
    const text = Usage.formatLowLimitAlert(account, usage.limits[2], { now });

    expect(text).toContain('Limit menipis: 7h Opus sisa 11%');
    expect(text).toContain('7h Opus');
  });

  it('says "habis" instead of "menipis" once the window is fully used', () => {
    const usage = Usage.normalize({
      limits: [{ kind: 'session', percent: 100, severity: 'critical' }]
    });
    const text = Usage.formatLowLimitAlert(account, usage.limits, { now });

    expect(text.split('\n')[0]).toBe('‼ Limit habis: 5 jam');
    // 0% left is used up, so claiming it is merely "running low" would be a
    // different (and wrong) claim.
    expect(text).not.toContain('menipis');
    expect(text).not.toContain('sisa 0%');
  });

  it('names each window state when one is out and another is only low', () => {
    const usage = Usage.normalize({
      limits: [
        { kind: 'session', percent: 100, severity: 'critical' },
        { kind: 'weekly_all', percent: 90, severity: 'warning' }
      ]
    });
    const text = Usage.formatLowLimitAlert(account, usage.limits, { now });

    expect(text.split('\n')[0]).toBe('‼ Limit menipis: 5 jam habis, 7 hari sisa 10%');
  });

  it('keeps a nearly-exhausted window as running low, not out', () => {
    const usage = Usage.normalize({
      limits: [{ kind: 'session', percent: 99.6, severity: 'critical' }]
    });
    const text = Usage.formatLowLimitAlert(account, usage.limits, { now });

    // Rounding 0.4% down to 0 would claim exhaustion that has not happened.
    expect(text.split('\n')[0]).toBe('‼ Limit menipis: 5 jam sisa 1%');
  });

  it('collects several low windows for one account into one message', () => {
    const usage = Usage.normalize(body());
    const text = Usage.formatLowLimitAlert(account, [usage.limits[0], usage.limits[2]], { now });

    expect(text.split('\n')[0]).toBe('‼ Limit menipis: 5 jam sisa 5%, 7h Opus sisa 11%');
    expect(text.split('\n')).toHaveLength(4);
  });
});

describe('bundle', () => {
  it('keeps blocks whole and starts a new message when one would overflow', () => {
    const messages = Usage.bundle(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)], 100);

    expect(messages).toEqual([`${'a'.repeat(40)}\n\n${'b'.repeat(40)}`, 'c'.repeat(40)]);
  });

  it('returns nothing for no blocks', () => {
    expect(Usage.bundle([])).toEqual([]);
  });

  it('cuts a single block that exceeds what Telegram accepts', () => {
    const [only] = Usage.bundle(['x'.repeat(5000)]);

    expect(only.length).toBeLessThanOrEqual(4096);
    expect(only).toMatch(/dipotong/);
  });
});

describe('formatting helpers', () => {
  it('renders a countdown the way the reference script does', () => {
    expect(wib.formatRemaining(0)).toBe('sekarang');
    expect(wib.formatRemaining(-5)).toBe('sekarang');
    expect(wib.formatRemaining(3 * 60 * 1000)).toBe('3m');
    expect(wib.formatRemaining((5 * 60 + 12) * 60 * 1000)).toBe('5j 12m');
    expect(wib.formatRemaining((26 * 60 + 30) * 60 * 1000)).toBe('1h 2j');
  });
});

describe('snapshotUsage', () => {
  const now = Date.parse('2026-11-22T16:00:00+00:00');

  it('emits numbers a consumer can use directly, with no display strings', () => {
    const snapshot = Usage.snapshotUsage(Usage.normalize(body()), now);

    expect(snapshot.limits[0]).toEqual({
      kind: 'session',
      title: '5 jam',
      percent_used: 95,
      percent_remaining: 5,
      severity: 'critical',
      exhausted: false,
      is_active: false,
      resets_at: '2026-11-22T17:00:00.316Z',
      resets_in_seconds: 3600,
      scope: null
    });
  });

  it('keeps a real fraction of a percent instead of rounding it away', () => {
    const snapshot = Usage.snapshotUsage(
      Usage.normalize({ limits: [{ kind: 'session', percent: 99.6 }] }),
      now
    );

    expect(snapshot.limits[0].percent_remaining).toBe(0.4);
    expect(snapshot.limits[0].exhausted).toBe(false);
  });

  it('flags an exhausted window', () => {
    const snapshot = Usage.snapshotUsage(
      Usage.normalize({ limits: [{ kind: 'session', percent: 100 }] }),
      now
    );

    expect(snapshot.limits[0].exhausted).toBe(true);
    expect(snapshot.limits[0].percent_remaining).toBe(0);
  });

  it('exposes the scope of a model-scoped weekly window', () => {
    const snapshot = Usage.snapshotUsage(Usage.normalize(body()), now);

    expect(snapshot.limits[2].scope).toEqual({ model: 'Opus', surface: null });
    expect(snapshot.limits[2].title).toBe('7h Opus');
  });

  it('reports credits as numbers, and null when there are none', () => {
    expect(Usage.snapshotUsage(Usage.normalize(body()), now).credits).toEqual({
      percent_used: 20,
      used: 2.5,
      limit: 10,
      balance: 7.5,
      currency: 'USD'
    });

    expect(Usage.snapshotUsage(
      Usage.normalize({ limits: [{ kind: 'session', percent: 1 }] }),
      now
    ).credits).toBeNull();
  });

  it('handles a window with no reset time', () => {
    const snapshot = Usage.snapshotUsage(
      Usage.normalize({ limits: [{ kind: 'session', percent: 5 }] }),
      now
    );

    expect(snapshot.limits[0].resets_at).toBeNull();
    expect(snapshot.limits[0].resets_in_seconds).toBeNull();
  });
});
