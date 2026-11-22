const fs = require('fs');
const path = require('path');
const nock = require('nock');

jest.mock('./Logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  init: jest.fn(),
  getLogLevel: jest.fn().mockReturnValue(0),
  createDebugStream: jest.fn()
}));

const OAuthManager = require('./OAuthManager');
const AutoPing = require('./AutoPing');
const Telegram = require('./Telegram');

const TEST_DIR = path.join(__dirname, '.test-auto-ping-accounts');
const STATE_PATH = path.join(TEST_DIR, 'accounts.json');
const TOKEN_PATH = path.join(TEST_DIR, 'tokens.json');

const addAccount = (suffix) => OAuthManager.addAccount({
  access_token: `token-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  expires_at: Date.now() + 3600000
}, {
  account_uuid: `uuid-${suffix}`,
  organization_uuid: `org-${suffix}`,
  email: `${suffix}@example.com`
});

const readState = () => JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

// nock hands back the parsed object for a JSON body, and the raw string for
// anything else, so accept both.
const bodyOf = (requestBody) =>
  typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody;

const patchAccount = (id, patch) => {
  const state = readState();
  Object.assign(state.accounts.find(a => a.id === id), patch);
  OAuthManager.saveState(state);
};

// One interceptor that survives every attempt, so an unexpected extra request
// is counted rather than thrown: the count is the proof.
const capture = (requests) => nock('https://api.anthropic.com')
  .persist()
  .post('/v1/messages')
  .query({ beta: 'true' })
  .reply(function (uri, requestBody) {
    requests.push({
      authorization: this.req.headers.authorization,
      body: bodyOf(requestBody)
    });
    return [200, JSON.stringify({ id: 'msg_ping' }), { 'content-type': 'application/json' }];
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
  AutoPing.stop();
  // Every tick now announces its outcome; the tests assert on the text, never
  // on a real api.telegram.org call.
  jest.spyOn(Telegram, 'send').mockResolvedValue(true);

  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

afterEach(() => {
  AutoPing.stop();
  jest.restoreAllMocks();
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  nock.cleanAll();
});

describe('AutoPing', () => {
  it('starts the next window with one minimal request, then waits', async () => {
    const requests = [];
    const account = addAccount('a');
    const fiveHourAt = Date.now() + 3600000;
    patchAccount(account.id, { five_hour_reset_at: Date.now() - 60000 });

    nock('https://api.anthropic.com')
      .persist()
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(function (uri, requestBody) {
        requests.push({
          authorization: this.req.headers.authorization,
          body: bodyOf(requestBody)
        });
        return [
          200,
          JSON.stringify({ id: 'msg_ping' }),
          {
            'content-type': 'application/json',
            'anthropic-ratelimit-unified-5h-reset': String(Math.floor(fiveHourAt / 1000))
          }
        ];
      });

    await AutoPing.tick();

    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe('Bearer token-a');
    expect(requests[0].body.model).toBe('claude-haiku-4-5');
    expect(requests[0].body.max_tokens).toBe(1);
    expect(requests[0].body.messages[0].content).toBe('ping');

    const stored = readState().accounts[0];
    expect(stored.five_hour_reset_at).toBe(Math.floor(fiveHourAt / 1000) * 1000);
    expect(stored.auto_ping_last_at).toBeGreaterThan(Date.now() - 5000);

    await AutoPing.tick();
    expect(requests).toHaveLength(1);
    expect(AutoPing.retries.size).toBe(0);
  });

  it('leaves disabled and rate-limited accounts alone', async () => {
    const requests = [];
    capture(requests);

    const disabled = addAccount('disabled');
    const limited = addAccount('limited');
    patchAccount(disabled.id, { disabled: true, five_hour_reset_at: Date.now() - 60000 });
    patchAccount(limited.id, {
      limited_until: Date.now() + 86400000,
      five_hour_reset_at: Date.now() - 60000
    });

    await AutoPing.tick();

    expect(requests).toHaveLength(0);
    expect(AutoPing.retries.size).toBe(0);
    expect(Telegram.send).not.toHaveBeenCalled();
  });

  it('records a 429 instead of a ping and does not claim the window started', async () => {
    const account = addAccount('a');
    const resetSec = Math.floor(Date.now() / 1000) + 600;
    const fiveHourSec = Math.floor(Date.now() / 1000) + 3600;
    patchAccount(account.id, { five_hour_reset_at: Date.now() - 60000 });

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(429, { type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } }, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-reset': String(resetSec),
        'anthropic-ratelimit-unified-5h-reset': String(fiveHourSec)
      });

    await AutoPing.tick();

    const stored = readState().accounts[0];
    expect(stored.limited_until).toBe(resetSec * 1000);
    expect(stored.five_hour_reset_at).toBe(fiveHourSec * 1000);
    expect(stored.auto_ping_last_at).toBeNull();
    expect(AutoPing.retries.size).toBe(0);
  });

  it('refreshes the target account, not the active one, on a 401', async () => {
    const target = addAccount('a');
    // Active but not due: a refresh that re-selects the active account would
    // exchange this account's refresh token instead of the target's.
    const active = addAccount('b');
    OAuthManager.activateAccount(active.id);
    patchAccount(target.id, { five_hour_reset_at: Date.now() - 60000 });
    patchAccount(active.id, { five_hour_reset_at: Date.now() + 3600000 });

    const authorizations = [];
    let calls = 0;

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(function () {
        authorizations.push(this.req.headers.authorization);
        calls += 1;
        return [401, { type: 'error', error: { type: 'authentication_error', message: 'expired' } }, {
          'content-type': 'application/json'
        }];
      });

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(function () {
        authorizations.push(this.req.headers.authorization);
        calls += 1;
        return [200, JSON.stringify({ id: 'msg_ping' }), { 'content-type': 'application/json' }];
      });

    const tokenScope = nock('https://console.anthropic.com')
      .post('/v1/oauth/token', body => body.refresh_token === 'refresh-a')
      .reply(200, { access_token: 'fresh-token', refresh_token: 'refresh-a', expires_in: 3600 });

    await AutoPing.tick();

    expect(tokenScope.isDone()).toBe(true);
    expect(calls).toBe(2);
    expect(authorizations).toEqual(['Bearer token-a', 'Bearer fresh-token']);
    expect(authorizations).not.toContain('Bearer token-b');

    const state = readState();
    expect(state.accounts.find(a => a.id === target.id).auto_ping_last_at)
      .toBeGreaterThan(Date.now() - 5000);
    expect(state.accounts.find(a => a.id === active.id).auto_ping_last_at).toBeNull();
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('pings each due account with its own token', async () => {
    const requests = [];
    addAccount('a');
    addAccount('b');

    const state = readState();
    state.accounts.forEach(account => { account.five_hour_reset_at = Date.now() - 60000; });
    OAuthManager.saveState(state);

    nock('https://api.anthropic.com')
      .persist()
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(function () {
        requests.push(this.req.headers.authorization);
        return [200, JSON.stringify({ id: 'msg_ping' }), { 'content-type': 'application/json' }];
      });

    await AutoPing.tick();

    expect(requests).toHaveLength(2);
    expect(new Set(requests)).toEqual(new Set(['Bearer token-a', 'Bearer token-b']));
  });

  it('backs a failed ping off instead of retrying on the next tick', async () => {
    const account = addAccount('a');
    patchAccount(account.id, { five_hour_reset_at: Date.now() - 60000 });

    let calls = 0;
    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(() => {
        calls += 1;
        return [500, { type: 'error' }, { 'content-type': 'application/json' }];
      });

    await AutoPing.tick();
    expect(calls).toBe(1);
    expect(AutoPing.retries.get(account.id)).toBeGreaterThan(Date.now());

    // No interceptor is left, so a second outbound attempt would fail and
    // land in the retry map again rather than staying silent.
    await AutoPing.tick();
    expect(calls).toBe(1);
  });

  it('backs a permanent 4xx off for an hour', async () => {
    const account = addAccount('a');
    patchAccount(account.id, { five_hour_reset_at: Date.now() - 60000 });

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(404, { type: 'error', error: { type: 'not_found_error', message: 'model' } }, {
        'content-type': 'application/json'
      });

    await AutoPing.tick();

    // An unknown model or revoked credentials do not fix themselves, so the
    // retry must be far enough out that this is not a five-minute loop.
    expect(AutoPing.retries.get(account.id)).toBeGreaterThan(Date.now() + (55 * 60 * 1000));
  });

  it('starts once, leaves the timer unref\'d, and stops cleanly', () => {
    AutoPing.start();
    const timer = AutoPing.timer;
    expect(timer).not.toBeNull();
    expect(timer.hasRef()).toBe(false);

    AutoPing.start();
    expect(AutoPing.timer).toBe(timer);

    AutoPing.stop();
    expect(AutoPing.timer).toBeNull();
    expect(AutoPing.retries.size).toBe(0);
  });

  it('does not start a second request while a tick is in flight', async () => {
    const account = addAccount('a');
    patchAccount(account.id, { five_hour_reset_at: Date.now() - 60000 });

    const requests = [];
    nock('https://api.anthropic.com')
      .persist()
      .post('/v1/messages')
      .query({ beta: 'true' })
      .delay(50)
      .reply(function () {
        requests.push(this.req.headers.authorization);
        return [200, JSON.stringify({ id: 'msg_ping' }), { 'content-type': 'application/json' }];
      });

    await Promise.all([AutoPing.tick(), AutoPing.tick()]);

    expect(requests).toHaveLength(1);
  });

  it('announces a successful ping with the account and the next ping time', async () => {
    const account = addAccount('a');
    const fiveHourSec = Math.floor(Date.now() / 1000) + 3600;
    patchAccount(account.id, { five_hour_reset_at: Date.now() - 60000 });

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(200, JSON.stringify({ id: 'msg_ping' }), {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-reset': String(fiveHourSec)
      });

    await AutoPing.tick();

    expect(Telegram.send).toHaveBeenCalledTimes(1);
    const text = Telegram.send.mock.calls[0][0];
    expect(text).toContain('Auto-ping claude-haiku-4-5: OK');
    expect(text).toContain('Account: a@example.com');
    expect(text).toContain('Detail: HTTP 200');
    // The window that just started is what the next ping waits for.
    expect(text).toContain(`Next ping: ${Telegram.formatJakarta((fiveHourSec * 1000) + 10000)}`);
  });

  it('announces a failed ping with its error and the backoff time', async () => {
    const account = addAccount('a');
    patchAccount(account.id, { five_hour_reset_at: Date.now() - 60000 });

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(500, { type: 'error' }, { 'content-type': 'application/json' });

    await AutoPing.tick();

    const retryAt = AutoPing.retries.get(account.id);
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(Telegram.send).toHaveBeenCalledTimes(1);
    const text = Telegram.send.mock.calls[0][0];
    expect(text).toContain('Auto-ping claude-haiku-4-5: FAILED');
    expect(text).toContain('Detail: auto ping got HTTP 500');
    expect(text).toContain(`Next ping: ${Telegram.formatJakarta(retryAt)}`);
  });

  it('reports a 429 and waits out the limit when it outlasts the window', async () => {
    const account = addAccount('a');
    const resetSec = Math.floor(Date.now() / 1000) + 7200;
    const fiveHourSec = Math.floor(Date.now() / 1000) + 3600;
    patchAccount(account.id, { five_hour_reset_at: Date.now() - 60000 });

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(429, { type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } }, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-reset': String(resetSec),
        'anthropic-ratelimit-unified-5h-reset': String(fiveHourSec)
      });

    await AutoPing.tick();

    expect(Telegram.send).toHaveBeenCalledTimes(1);
    const text = Telegram.send.mock.calls[0][0];
    expect(text).toContain('Auto-ping claude-haiku-4-5: FAILED');
    expect(text).toContain('Detail: HTTP 429 rate limit');
    expect(text).toContain(`Next ping: ${Telegram.formatJakarta(resetSec * 1000)}`);
  });
});
