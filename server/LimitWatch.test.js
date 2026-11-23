const fs = require('fs');
const path = require('path');
const nock = require('nock');

jest.mock('./Logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  init: jest.fn(),
  getLogLevel: jest.fn().mockReturnValue(0)
}));

const OAuthManager = require('./OAuthManager');
const Telegram = require('./Telegram');
const LimitWatch = require('./LimitWatch');
const wib = require('./wib');

const TEST_DIR = path.join(__dirname, '.test-limit-watch');
const STATE_PATH = path.join(TEST_DIR, 'accounts.json');
const TOKEN_PATH = path.join(TEST_DIR, 'tokens.json');
const TELEGRAM_PATH = path.join(TEST_DIR, 'telegram.json');

const addAccount = (suffix) => OAuthManager.addAccount({
  access_token: `token-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  expires_at: Date.now() + 3600000
}, {
  account_uuid: `uuid-${suffix}`,
  organization_uuid: `org-${suffix}`,
  email: `${suffix}@example.com`
});

const usageBody = ({ session = 95, weekly = 46 } = {}) => ({
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: session,
      severity: session >= 90 ? 'critical' : 'normal',
      resets_at: '2026-11-24T10:00:00+00:00',
      scope: null,
      is_active: false
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: weekly,
      severity: weekly >= 90 ? 'critical' : 'normal',
      resets_at: '2026-11-28T01:00:00+00:00',
      scope: null,
      is_active: true
    }
  ],
  spend: { enabled: false }
});

const configureTelegram = (extra = {}) => Telegram.saveSettings({
  bot_token: '123:abc',
  chat_id: '-100123',
  ...extra
});

// Answers every usage call with the body for the bearer token presented, and
// records what was asked for.
const mockUsage = (requests, byToken = {}) => nock('https://api.anthropic.com')
  .persist()
  .get('/api/oauth/usage')
  .reply(function () {
    const authorization = this.req.headers.authorization;
    requests.push({ authorization });
    const key = String(authorization).replace(/^Bearer\s+/, '');
    const body = byToken[key] || usageBody();
    return [200, JSON.stringify(body)];
  });

beforeAll(() => {
  nock.disableNetConnect();
});

afterAll(() => {
  nock.enableNetConnect();
});

beforeEach(() => {
  nock.cleanAll();
  OAuthManager.statePath = STATE_PATH;
  OAuthManager.tokenPath = TOKEN_PATH;
  OAuthManager.refreshPromises.clear();
  Telegram.settingsPath = TELEGRAM_PATH;
  LimitWatch.reset();
  LimitWatch.stop();
  LimitWatch.alertTimer = null;
  LimitWatch.reportTimer = null;

  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

afterEach(() => {
  LimitWatch.reset();
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  nock.cleanAll();
});

describe('pollLowLimits', () => {
  it('labels the alert with the account that owns the window', async () => {
    const account = addAccount('low');
    configureTelegram();

    const sent = [];
    nock('https://api.telegram.org')
      .persist()
      .post('/bot123:abc/sendMessage')
      .reply(200, function (uri, requestBody) {
        sent.push(requestBody.text);
        return { ok: true };
      });
    mockUsage([]);

    const announced = await LimitWatch.pollLowLimits();

    expect(announced).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Limit menipis: 5 jam sisa 5%');
    expect(sent[0]).toContain(`Akun: ${account.label} [aktif]`);
  });

  it('alerts once per window and again only when the window resets', async () => {
    addAccount('low');
    configureTelegram();

    const sent = [];
    nock('https://api.telegram.org')
      .persist()
      .post('/bot123:abc/sendMessage')
      .reply(200, function (uri, requestBody) {
        sent.push(requestBody.text);
        return { ok: true };
      });
    mockUsage([]);

    expect(await LimitWatch.pollLowLimits()).toHaveLength(1);
    expect(await LimitWatch.pollLowLimits()).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it('treats a jittering reset time as the same window', async () => {
    const account = addAccount('low');
    configureTelegram();

    const now = Date.now();
    const at = { resetsAt: now + 3600000 };
    const jitter = { resetsAt: now + 3600000 + 2000 };

    expect(LimitWatch.shouldAlert(account, { kind: 'session', ...at }, now)).toBe(true);
    expect(LimitWatch.shouldAlert(account, { kind: 'session', ...jitter }, now + 1000)).toBe(false);
  });

  it('re-arms for a genuinely new window even when the previous alert was recent', async () => {
    const account = addAccount('low');
    configureTelegram();

    const now = Date.now();
    LimitWatch.shouldAlert(account, { kind: 'session', resetsAt: now + 3600000 }, now);

    // The next window's reset is five hours later: a different window.
    expect(LimitWatch.shouldAlert(
      account,
      { kind: 'session', resetsAt: now + 6 * 3600000 },
      now + 1000
    )).toBe(true);
  });

  it('sends nothing when the remaining allowance is above the threshold', async () => {
    addAccount('healthy');
    configureTelegram();

    const scope = nock('https://api.telegram.org').post(/.*/).reply(200, { ok: true });
    mockUsage([], { 'token-healthy': usageBody({ session: 31, weekly: 46 }) });

    const announced = await LimitWatch.pollLowLimits({ accounts: OAuthManager.loadState().accounts });

    expect(announced).toEqual([]);
    expect(scope.isDone()).toBe(false);
  });

  it('does not call the usage endpoint when Telegram is unconfigured', async () => {
    addAccount('low');

    const requests = [];
    mockUsage(requests);

    expect(await LimitWatch.pollLowLimits()).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('sends nothing when limit alerts are switched off', async () => {
    addAccount('low');
    configureTelegram({ limit_alerts_enabled: false });

    const scope = nock('https://api.telegram.org').post(/.*/).reply(200, { ok: true });

    expect(await LimitWatch.pollLowLimits()).toEqual([]);
    expect(scope.isDone()).toBe(false);
  });

  it('honours a custom threshold', async () => {
    addAccount('mid');
    configureTelegram({ limit_alert_threshold: 60 });

    const sent = [];
    nock('https://api.telegram.org')
      .persist()
      .post('/bot123:abc/sendMessage')
      .reply(200, function (uri, requestBody) {
        sent.push(requestBody.text);
        return { ok: true };
      });
    mockUsage([]);

    await LimitWatch.pollLowLimits();

    // 46% used is 54% left: both the session and the weekly window are within
    // the last 60%, and both are listed in the one account message.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Limit menipis: 5 jam sisa 5%, 7 hari sisa 54%');
  });

  it('re-arms an alert when delivery fails', async () => {
    addAccount('low');
    configureTelegram();

    nock('https://api.telegram.org').post(/.*/).reply(500, { ok: false });
    mockUsage([]);

    expect(await LimitWatch.pollLowLimits()).toEqual([]);

    const sent = [];
    nock('https://api.telegram.org')
      .persist()
      .post('/bot123:abc/sendMessage')
      .reply(200, function (uri, requestBody) {
        sent.push(requestBody.text);
        return { ok: true };
      });

    expect(await LimitWatch.pollLowLimits()).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('checks each account with its own token', async () => {
    addAccount('a');
    addAccount('b');
    configureTelegram();

    const requests = [];
    mockUsage(requests);
    nock('https://api.telegram.org').persist().post(/.*/).reply(200, { ok: true });

    await LimitWatch.pollLowLimits();

    expect(requests.map(request => request.authorization).sort())
      .toEqual(['Bearer token-a', 'Bearer token-b']);
  });

  it('skips a disabled account', async () => {
    const account = addAccount('off');
    OAuthManager.disableAccount(account.id);
    configureTelegram();

    const requests = [];
    mockUsage(requests);

    await LimitWatch.pollLowLimits();

    expect(requests).toEqual([]);
  });

  it('keeps going when one account fails and reports the rest', async () => {
    addAccount('bad');
    addAccount('good');
    configureTelegram();

    const sent = [];
    nock('https://api.anthropic.com')
      .persist()
      .get('/api/oauth/usage')
      .reply(function () {
        const token = String(this.req.headers.authorization).replace('Bearer ', '');
        if (token === 'token-bad') return [500, 'boom'];
        return [200, JSON.stringify(usageBody())];
      });
    nock('https://api.telegram.org')
      .persist()
      .post('/bot123:abc/sendMessage')
      .reply(200, function (uri, requestBody) {
        sent.push(requestBody.text);
        return { ok: true };
      });

    await LimitWatch.pollLowLimits();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('good@example.com');
  });
});

describe('sendReport', () => {
  it('sends one labelled block per account in the reference format', async () => {
    const first = addAccount('first');
    const second = addAccount('second');
    configureTelegram();

    const sent = [];
    nock('https://api.telegram.org')
      .persist()
      .post('/bot123:abc/sendMessage')
      .reply(200, function (uri, requestBody) {
        sent.push(requestBody.text);
        return { ok: true };
      });
    mockUsage([]);

    const result = await LimitWatch.sendReport({ now: Date.parse('2026-11-24T03:04:05Z') });

    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Sisa limit — 24 Nov 2026, 10:04:05 WIB');
    expect(sent[0]).toContain(`Akun: ${first.label} [aktif]`);
    expect(sent[0]).toContain(`Akun: ${second.label}`);
    expect(sent[0]).toContain('5 jam');
    expect(sent[0]).toContain('7 hari');
    expect(sent[0]).toContain('reset');
  });

  it('still reports when the upstream has no data, naming the account', async () => {
    const account = addAccount('broken');
    configureTelegram();

    const sent = [];
    nock('https://api.anthropic.com').persist().get('/api/oauth/usage').reply(500, 'boom');
    nock('https://api.telegram.org')
      .persist()
      .post('/bot123:abc/sendMessage')
      .reply(200, function (uri, requestBody) {
        sent.push(requestBody.text);
        return { ok: true };
      });

    const result = await LimitWatch.sendReport();

    expect(result.failed).toEqual([account.label]);
    expect(sent[0]).toContain(`Akun: ${account.label}`);
    expect(sent[0]).toContain('Gagal mengambil data limit');
  });

  it('says so when there is nothing to report', async () => {
    configureTelegram();

    const result = await LimitWatch.sendReport();

    expect(result).toEqual({ sent: false, text: 'Tidak ada akun tersimpan.', failed: [] });
  });

  it('splits account blocks that would overflow one message', async () => {
    addAccount('a');
    configureTelegram();

    const sent = [];
    nock('https://api.telegram.org')
      .persist()
      .post('/bot123:abc/sendMessage')
      .reply(200, function (uri, requestBody) {
        sent.push(requestBody.text);
        return { ok: true };
      });
    mockUsage([]);

    const many = Array.from({ length: 80 }, (_, index) => ({
      id: `acct-${index}`,
      label: `account-${index}@example.com`,
      email: `account-${index}@example.com`,
      access_token: 'token-a',
      refresh_token: 'refresh-a'
    }));
    const result = await LimitWatch.sendReport({ accounts: many });

    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every(message => message.length <= 4096)).toBe(true);
    expect(result.sent).toBe(true);
  });
});

describe('tickReports', () => {
  it('does nothing until the scheduled slot arrives', async () => {
    addAccount('a');
    configureTelegram({ limit_report_cron: '0 8 * * *' });

    const scope = nock('https://api.telegram.org').post(/.*/).reply(200, { ok: true });
    const now = Date.parse('2026-11-24T01:00:00Z'); // 08:00 WIB

    // First tick adopts the schedule without firing.
    expect(await LimitWatch.tickReports(now)).toBe(false);
    expect(LimitWatch.nextRunAt).toBe(now + 24 * 60 * 60 * 1000);
    expect(scope.isDone()).toBe(false);
  });

  it('sends once the stored slot is reached and advances the slot', async () => {
    addAccount('a');
    configureTelegram({ limit_report_cron: '0 8 * * *' });

    const sent = [];
    nock('https://api.anthropic.com').persist().get('/api/oauth/usage')
      .reply(200, JSON.stringify(usageBody()));
    nock('https://api.telegram.org')
      .persist()
      .post('/bot123:abc/sendMessage')
      .reply(200, function (uri, requestBody) {
        sent.push(requestBody.text);
        return { ok: true };
      });

    LimitWatch.nextRunAt = Date.parse('2026-11-24T01:00:00Z') - 1;
    LimitWatch.cronExpression = '0 8 * * *';

    expect(await LimitWatch.tickReports(Date.parse('2026-11-24T01:00:00Z'))).toBe(true);
    expect(sent[0]).toContain('Sisa limit —');
    expect(LimitWatch.nextRunAt).toBe(Date.parse('2026-11-25T01:00:00Z'));
  });

  it('re-adopts the schedule when the expression changes', async () => {
    addAccount('a');
    configureTelegram({ limit_report_cron: '0 8 * * *' });
    LimitWatch.cronExpression = '0 8 * * *';
    LimitWatch.nextRunAt = Date.parse('2026-11-24T01:00:00Z');

    configureTelegram({ limit_report_cron: '30 9 * * *' });

    expect(await LimitWatch.tickReports(Date.parse('2026-11-24T02:29:00Z'))).toBe(false);
    expect(wib.formatFull(LimitWatch.nextRunAt)).toBe('24 Nov 2026, 09:30:00 WIB');
  });

  it('clears the schedule when the expression is emptied', async () => {
    configureTelegram({ limit_report_cron: '' });
    LimitWatch.cronExpression = '0 8 * * *';
    LimitWatch.nextRunAt = Date.parse('2026-11-24T01:00:00Z');

    expect(await LimitWatch.tickReports(Date.now())).toBe(false);
    expect(LimitWatch.nextRunAt).toBeNull();
  });

  it('does not fire twice for the same slot', async () => {
    addAccount('a');
    configureTelegram({ limit_report_cron: '0 8 * * *' });
    LimitWatch.cronExpression = '0 8 * * *';
    LimitWatch.nextRunAt = Date.parse('2026-11-24T01:00:00Z');

    const sent = [];
    nock('https://api.anthropic.com').persist().get('/api/oauth/usage')
      .reply(200, JSON.stringify(usageBody()));
    nock('https://api.telegram.org')
      .persist()
      .post('/bot123:abc/sendMessage')
      .reply(200, function (uri, requestBody) {
        sent.push(requestBody.text);
        return { ok: true };
      });

    await LimitWatch.tickReports(Date.parse('2026-11-24T01:00:00Z'));
    await LimitWatch.tickReports(Date.parse('2026-11-24T01:00:01Z'));

    expect(sent).toHaveLength(1);
  });
});

describe('describeSchedule', () => {
  it('describes an expression and its next run', () => {
    const preview = LimitWatch.describeSchedule('0 8 * * *', Date.parse('2026-11-24T01:00:00Z'));

    expect(preview.valid).toBe(true);
    expect(preview.description).toBe('Setiap hari pukul 08:00');
    expect(preview.next_run).toBe('25 Nov 2026, 08:00:00 WIB');
  });

  it('treats an empty expression as an intentionally disabled schedule', () => {
    expect(LimitWatch.describeSchedule('')).toEqual({ valid: true });
  });

  it('reports a malformed expression instead of throwing', () => {
    const preview = LimitWatch.describeSchedule('0 8 * *');

    expect(preview.valid).toBe(false);
    expect(preview.error).toMatch(/5 fields/);
  });
});
