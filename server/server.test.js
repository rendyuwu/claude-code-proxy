// Route-level tests that drive the real handleRequest with the real
// OAuthManager, pointed at a temporary account store.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const nock = require('nock');
const request = require('supertest');

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
const Usage = require('./Usage');
const { handleRequest } = require('./server');

const TEST_DIR = path.join(__dirname, '.test-server-accounts');
const STATE_PATH = path.join(TEST_DIR, 'accounts.json');
const TOKEN_PATH = path.join(TEST_DIR, 'tokens.json');
const TELEGRAM_PATH = path.join(TEST_DIR, 'telegram.json');

// This host's first non-loopback IPv4, or null when it only has loopback.
// Used to make a request whose socket address is genuinely off-box.
const nonLoopbackAddress = () => {
  const found = Object.values(os.networkInterfaces())
    .flat()
    .find(item => item && item.family === 'IPv4' && !item.internal);
  return found ? found.address : null;
};

const server = () => http.createServer(handleRequest);

const tokensFor = (suffix) => ({
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  expires_in: 3600,
  account: { uuid: `uuid-${suffix}`, email_address: `${suffix}@example.com` },
  organization: { uuid: `org-${suffix}` }
});

const startLogin = async () => {
  const response = await request(server()).get('/auth/get-url');
  expect(response.status).toBe(200);
  return response.body.state;
};

const completeLogin = async (tokens) => {
  const state = await startLogin();
  const tokenScope = nock('https://console.anthropic.com')
    .post('/v1/oauth/token')
    .reply(200, tokens);

  const response = await request(server())
    .get('/auth/callback')
    .query({ manual_code: `test-code#${state}` });

  expect(tokenScope.isDone()).toBe(true);
  return response;
};

beforeAll(() => {
  nock.disableNetConnect();
  // enableNetConnect replaces its matcher rather than accumulating, so one
  // regex covers loopback plus this host's own address: one test talks to the
  // non-loopback address to prove the allowlist reads the socket, not a header.
  // nock passes "host:port" to the matcher, so the anchors must allow the port.
  const host = nonLoopbackAddress();
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = host
    ? new RegExp(`^(127\\.0\\.0\\.1|::1|${escape(host)})(:|$)`)
    : /^(127\.0\.0\.1|::1)(:|$)/;
  nock.enableNetConnect(pattern);
});

afterAll(() => {
  nock.enableNetConnect();
});

beforeEach(() => {
  nock.cleanAll();
  OAuthManager.statePath = STATE_PATH;
  OAuthManager.tokenPath = TOKEN_PATH;
  OAuthManager.refreshPromises.clear();
  // The settings routes write beside the account store, never into $HOME.
  Telegram.settingsPath = TELEGRAM_PATH;

  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  nock.cleanAll();
  delete process.env.PROXY_API_KEY;
  delete process.env.AUTH_ROUTES_ENABLED;
});

describe('GET /auth/get-url', () => {
  it('returns an authorize URL and a state', async () => {
    const response = await request(server()).get('/auth/get-url');

    expect(response.status).toBe(200);
    expect(response.body.url).toContain('https://claude.ai/oauth/authorize');
    expect(response.body.url).toContain('client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(response.body.url).toContain('code_challenge_method=S256');
    expect(response.body.state).toEqual(expect.any(String));
  });
});

describe('GET /auth/login', () => {
  it('serves the login page', async () => {
    const response = await request(server()).get('/auth/login');

    expect(response.status).toBe(200);
    expect(response.text).toContain('Authenticate with Claude');
  });
});

describe('GET /auth/callback', () => {
  it('registers an account from the token response', async () => {
    const response = await completeLogin(tokensFor('a'));

    expect(response.status).toBe(200);
    expect(response.text).toContain('Authentication Successful');

    const status = OAuthManager.getStatus();
    expect(status.authenticated).toBe(true);
    expect(status.accounts).toHaveLength(1);
    expect(status.accounts[0]).toMatchObject({
      label: 'a@example.com',
      email: 'a@example.com',
      active: true,
      limited: false
    });
    expect(status.active_account_id).toBe(status.accounts[0].id);
  });

  it('appends a second identity without moving the active account', async () => {
    await completeLogin(tokensFor('a'));
    const first = OAuthManager.getStatus();

    await completeLogin(tokensFor('b'));
    const second = OAuthManager.getStatus();

    expect(second.accounts).toHaveLength(2);
    expect(second.active_account_id).toBe(first.active_account_id);
    expect(second.accounts.find(a => a.active).label).toBe('a@example.com');
  });

  it('replaces the tokens of a re-logged identity and clears its limit', async () => {
    await completeLogin(tokensFor('a'));
    await completeLogin(tokensFor('b'));

    const before = OAuthManager.getStatus();
    const firstId = before.accounts.find(a => a.label === 'a@example.com').id;

    // Limit the first account so the retry state is visibly reset by a login.
    OAuthManager.markAccountLimited(firstId, { resetAtMs: Date.now() + 60000 });
    expect(OAuthManager.getStatus().accounts.find(a => a.id === firstId).limited).toBe(true);

    const relogin = tokensFor('a');
    relogin.access_token = 'access-a-new';
    relogin.refresh_token = 'refresh-a-new';
    await completeLogin(relogin);

    const after = OAuthManager.getStatus();
    expect(after.accounts).toHaveLength(2);
    expect(after.accounts.find(a => a.id === firstId)).toMatchObject({
      label: 'a@example.com',
      limited: false,
      limited_until: null
    });

    const stored = OAuthManager.loadState().accounts.find(a => a.id === firstId);
    expect(stored.access_token).toBe('access-a-new');
    expect(stored.refresh_token).toBe('refresh-a-new');
    expect(stored.limited_until).toBeNull();
  });

  it('resolves identity from the profile when the token response omits it', async () => {
    await completeLogin(tokensFor('a'));
    expect(OAuthManager.accountCount()).toBe(1);

    nock('https://api.anthropic.com')
      .get('/api/oauth/profile')
      .reply(200, {
        account: { uuid: 'uuid-a', email: 'a@example.com' },
        organization: { uuid: 'org-a' }
      });

    const anonymous = {
      access_token: 'access-anonymous',
      refresh_token: 'refresh-anonymous',
      expires_in: 3600
    };
    await completeLogin(anonymous);

    const status = OAuthManager.getStatus();
    expect(status.accounts).toHaveLength(1);
    expect(status.accounts[0].label).toBe('a@example.com');
    expect(OAuthManager.loadState().accounts[0].access_token).toBe('access-anonymous');
  });

  it('returns error if code is missing', async () => {
    const response = await request(server()).get('/auth/callback?state=test-state');

    expect(response.status).toBe(500);
    expect(response.text).toContain('Authentication Failed');
    expect(response.text).toContain('Missing authorization code or state');
  });

  it('returns error if state is missing', async () => {
    const response = await request(server()).get('/auth/callback?code=test-code');

    expect(response.status).toBe(500);
    expect(response.text).toContain('Missing authorization code or state');
  });

  it('returns error if state is invalid', async () => {
    const response = await request(server()).get('/auth/callback?code=test-code&state=invalid-state');

    expect(response.status).toBe(500);
    expect(response.text).toContain('Invalid or expired state parameter');
  });
});

describe('GET /auth/status', () => {
  it('reports no authentication when the store is empty', async () => {
    const response = await request(server()).get('/auth/status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      authenticated: false,
      active_account_id: null,
      expires_at: null,
      accounts: []
    });
  });

  it('lists sanitized accounts with ISO timestamps', async () => {
    await completeLogin(tokensFor('a'));
    await completeLogin(tokensFor('b'));
    OAuthManager.markAccountLimited(
      OAuthManager.loadState().accounts[0].id,
      { resetAtMs: Date.now() + 60000 }
    );

    const response = await request(server()).get('/auth/status');

    expect(response.status).toBe(200);
    expect(response.body.authenticated).toBe(true);
    expect(response.body.accounts).toHaveLength(2);
    expect(response.body.expires_at).toEqual(expect.any(String));

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('access_token');
    expect(body).not.toContain('refresh_token');
    expect(body).not.toContain('access-');

    const limited = response.body.accounts.find(a => a.limited);
    expect(limited.limited_until).toEqual(expect.any(String));
    expect(new Date(limited.limited_until).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('account management routes', () => {
  const SONNET = 'claude-sonnet-4-5-20250929';

  const addAccount = (suffix) => OAuthManager.addAccount({
    access_token: `token-${suffix}`,
    refresh_token: `refresh-${suffix}`,
    expires_at: Date.now() + 3600000
  }, {
    account_uuid: `uuid-${suffix}`,
    organization_uuid: `org-${suffix}`,
    email: `${suffix}@example.com`
  });

  it('serves the management page', async () => {
    const response = await request(server()).get('/auth/accounts');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('OAuth Accounts');
    expect(response.text).toContain('id="telegram-silent-models"');
  });

  it('disables the active account and reports the next one', async () => {
    const a = addAccount('a');
    const b = addAccount('b');

    const response = await request(server()).post(`/auth/accounts/${a.id}/disable`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.active_account_id).toBe(b.id);
    expect(response.body.accounts.find(x => x.id === a.id).disabled).toBe(true);
    expect(response.body.accounts.find(x => x.id === a.id).active).toBe(false);

    // Same payload shape as /auth/status, timestamps included.
    const active = response.body.accounts.find(x => x.id === b.id);
    expect(new Date(active.expires_at).toISOString()).toBe(active.expires_at);
    expect(active.limited_until).toBeNull();

    const status = await request(server()).get('/auth/status');
    expect(status.body.active_account_id).toBe(b.id);
    expect(status.body.accounts.find(x => x.id === a.id).disabled).toBe(true);
  });

  it('activates an account', async () => {
    const a = addAccount('a');
    addAccount('b');
    await request(server()).post(`/auth/accounts/${a.id}/disable`);

    const response = await request(server()).post(`/auth/accounts/${a.id}/activate`);

    expect(response.status).toBe(200);
    expect(response.body.active_account_id).toBe(a.id);
    expect(response.body.accounts.find(x => x.id === a.id)).toMatchObject({
      active: true,
      disabled: false
    });
  });

  it('deletes one account and keeps the active one', async () => {
    const a = addAccount('a');
    const b = addAccount('b');

    const response = await request(server()).delete(`/auth/accounts/${b.id}`);

    expect(response.status).toBe(200);
    expect(response.body.accounts).toHaveLength(1);
    expect(response.body.accounts[0].id).toBe(a.id);
    expect(response.body.active_account_id).toBe(a.id);
    expect(OAuthManager.loadState().accounts).toHaveLength(1);
  });

  it('404s an unknown id on every mutation', async () => {
    addAccount('a');

    for (const path of [
      '/auth/accounts/nope/disable',
      '/auth/accounts/nope/activate'
    ]) {
      const response = await request(server()).post(path);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Account not found' });
    }

    const deleted = await request(server()).delete('/auth/accounts/nope');

    expect(deleted.status).toBe(404);
    expect(deleted.body).toEqual({ error: 'Account not found' });
    expect(OAuthManager.accountCount()).toBe(1);
  });

  it('reports a junk stored timestamp as null instead of failing the request', async () => {
    // 1e999 parses to Infinity, which new Date().toISOString() rejects.
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, `{
      "active_account_id": null,
      "accounts": [{
        "id": "a",
        "label": "a@example.com",
        "email": null,
        "access_token": "access-a",
        "refresh_token": "refresh-a",
        "expires_at": 1e999,
        "limited_until": 1e999,
        "limited_reason": null,
        "last_limit_at": null,
        "created_at": 1
      }]
    }`, { mode: 0o600 });

    const status = await request(server()).get('/auth/status');

    expect(status.status).toBe(200);
    expect(status.body.expires_at).toBeNull();
    expect(status.body.accounts[0].expires_at).toBeNull();
    expect(status.body.accounts[0].limited_until).toBeNull();

    const disabled = await request(server()).post('/auth/accounts/a/disable');

    expect(disabled.status).toBe(200);
    expect(disabled.body.accounts[0].expires_at).toBeNull();
  });

  it('401s /v1/messages with a clear message when every account is disabled', async () => {
    addAccount('a');
    addAccount('b');
    for (const account of OAuthManager.loadState().accounts) {
      OAuthManager.disableAccount(account.id);
    }
    expect(OAuthManager.getStatus().all_disabled).toBe(true);

    const response = await request(server())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('All OAuth accounts are disabled; activate one at /auth/accounts');
    expect(nock.pendingMocks()).toEqual([]);
  });
});

describe('GET /auth/logout', () => {
  it('removes every account and reports logged out', async () => {
    await completeLogin(tokensFor('a'));
    expect(OAuthManager.isAuthenticated()).toBe(true);

    const logout = await request(server()).get('/auth/logout');

    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ success: true, message: 'Logged out successfully' });
    expect(OAuthManager.accountCount()).toBe(0);

    const status = await request(server()).get('/auth/status');
    expect(status.body.authenticated).toBe(false);
    expect(status.body.accounts).toEqual([]);
  });

  it('succeeds when nothing is stored', async () => {
    const response = await request(server()).get('/auth/logout');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});

describe('POST /v1/messages 429 failover', () => {
  const SONNET = 'claude-sonnet-4-5-20250929';

  const addAccount = (suffix) => OAuthManager.addAccount({
    access_token: `token-${suffix}`,
    refresh_token: `refresh-${suffix}`,
    expires_at: Date.now() + 3600000
  }, {
    account_uuid: `uuid-${suffix}`,
    organization_uuid: `org-${suffix}`,
    email: `${suffix}@example.com`
  });

  it('retries on the next stored account and persists the limit', async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 3600;
    const fiveHourSec = Math.floor(Date.now() / 1000) + 18000;
    const authorizations = [];

    addAccount('a1');
    const second = addAccount('a2');

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(function () {
        authorizations.push(this.req.headers.authorization);
        return [
          429,
          JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } }),
          {
            'content-type': 'application/json',
            'anthropic-ratelimit-unified-reset': String(resetSec),
            'anthropic-ratelimit-unified-5h-reset': String(resetSec)
          }
        ];
      });

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(function () {
        authorizations.push(this.req.headers.authorization);
        return [
          200,
          JSON.stringify({ id: 'msg_2' }),
          {
            'content-type': 'application/json',
            'anthropic-ratelimit-unified-5h-reset': String(fiveHourSec)
          }
        ];
      });

    const response = await request(server())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe('msg_2');
    expect(authorizations).toEqual(['Bearer token-a1', 'Bearer token-a2']);

    const state = OAuthManager.loadState();
    expect(state.active_account_id).toBe(second.id);
    const limited = state.accounts.find(a => a.email === 'a1@example.com');
    expect(limited.limited_until).toBe(resetSec * 1000);
    expect(limited.limited_reason).toBe('rate_limit');
    expect(limited.five_hour_reset_at).toBe(resetSec * 1000);

    // The successful retry's own header advances the account that served it.
    const served = state.accounts.find(a => a.email === 'a2@example.com');
    expect(served.five_hour_reset_at).toBe(fiveHourSec * 1000);
  });
});

describe('POST /v1/messages 5-hour window recording', () => {
  const SONNET = 'claude-sonnet-4-5-20250929';

  it('keeps the response a 200 when the window end cannot be stored', async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 3600;
    OAuthManager.addAccount({
      access_token: 'access-a',
      refresh_token: 'refresh-a',
      expires_at: Date.now() + 3600000
    }, {
      account_uuid: 'uuid-a',
      organization_uuid: 'org-a',
      email: 'a@example.com'
    });

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(200, { id: 'msg_1' }, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-reset': String(resetSec)
      });

    // A full disk must not turn a good upstream answer into a 500.
    const save = jest.spyOn(OAuthManager, 'saveState').mockImplementation(() => {
      throw new Error('disk full');
    });

    try {
      const response = await request(server())
        .post('/v1/messages')
        .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('msg_1');
    } finally {
      save.mockRestore();
    }
  });
});

describe('GET /limits', () => {
  const usageReply = (session = 96, weekly = 46) => ({
    limits: [
      {
        kind: 'session',
        percent: session,
        severity: session >= 90 ? 'critical' : 'normal',
        resets_at: '2026-11-24T10:00:00+00:00',
        is_active: false
      },
      {
        kind: 'weekly_all',
        percent: weekly,
        severity: 'normal',
        resets_at: '2026-11-28T01:00:00+00:00',
        is_active: true
      }
    ],
    spend: { enabled: false }
  });

  const addAccount = (suffix) => OAuthManager.addAccount({
    access_token: `access-${suffix}`,
    refresh_token: `refresh-${suffix}`,
    expires_at: Date.now() + 3600000
  }, {
    account_uuid: `uuid-${suffix}`,
    organization_uuid: `org-${suffix}`,
    email: `${suffix}@example.com`
  });

  afterEach(() => {
    delete process.env.LIMITS_ALLOWLIST;
    Usage.clearUsageCache();
  });

  it('returns a simple JSON array of accounts with their limits', async () => {
    const account = addAccount('a');
    nock('https://api.anthropic.com').get('/api/oauth/usage').reply(200, usageReply());

    const response = await request(server()).get('/limits');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body.timezone).toBe('Asia/Jakarta');
    expect(response.body.generated_at).toEqual(expect.any(String));
    expect(Array.isArray(response.body.accounts)).toBe(true);

    expect(response.body.accounts).toHaveLength(1);
    expect(response.body.accounts[0]).toMatchObject({
      id: account.id,
      label: 'a@example.com',
      email: 'a@example.com',
      active: true,
      disabled: false,
      ok: true,
      stale: false
    });
    expect(response.body.accounts[0].limits).toHaveLength(2);
    expect(response.body.accounts[0].limits[0]).toMatchObject({
      kind: 'session',
      title: '5 jam',
      percent_used: 96,
      percent_remaining: 4,
      severity: 'critical',
      exhausted: false,
      is_active: false
    });
    expect(response.body.accounts[0].limits[1]).toMatchObject({
      kind: 'weekly_all',
      title: '7 hari',
      is_active: true
    });
    // Never leak the credential itself.
    expect(JSON.stringify(response.body)).not.toContain('access-a');
    expect(JSON.stringify(response.body)).not.toContain('refresh-a');
  });

  it('marks a fully used window as exhausted', async () => {
    addAccount('a');
    nock('https://api.anthropic.com').get('/api/oauth/usage').reply(200, usageReply(100, 10));

    const response = await request(server()).get('/limits');

    expect(response.body.accounts[0].limits[0]).toMatchObject({
      percent_used: 100,
      percent_remaining: 0,
      exhausted: true
    });
  });

  it('includes a reset countdown and an ISO reset time', async () => {
    addAccount('a');
    nock('https://api.anthropic.com').get('/api/oauth/usage').reply(200, usageReply());

    const response = await request(server()).get('/limits');
    const limit = response.body.accounts[0].limits[0];

    expect(limit.resets_at).toBe('2026-11-24T10:00:00.000Z');
    expect(limit.resets_in_seconds).toEqual(expect.any(Number));
  });

  it('reports credits only when the account reports them', async () => {
    addAccount('a');
    nock('https://api.anthropic.com').get('/api/oauth/usage').reply(200, {
      limits: [{ kind: 'session', percent: 10, severity: 'normal' }]
    });

    const without = await request(server()).get('/limits');
    expect(without.body.accounts[0].credits).toBeNull();

    Usage.clearUsageCache();
    nock('https://api.anthropic.com').get('/api/oauth/usage').reply(200, {
      limits: [{ kind: 'session', percent: 10, severity: 'normal' }],
      spend: {
        enabled: true,
        percent: 20,
        used: { amount_minor: 250, exponent: 2, currency: 'USD' },
        limit: { amount_minor: 1000, exponent: 2 },
        balance: { amount_minor: 750, exponent: 2 }
      }
    });

    const withCredits = await request(server()).get('/limits');
    expect(withCredits.body.accounts[0].credits).toEqual({
      percent_used: 20,
      used: 2.5,
      limit: 10,
      balance: 7.5,
      currency: 'USD'
    });
  });

  it('keeps the other accounts when one upstream call fails', async () => {
    addAccount('bad');
    addAccount('good');
    nock('https://api.anthropic.com')
      .persist()
      .get('/api/oauth/usage')
      .reply(function () {
        const token = String(this.req.headers.authorization).replace('Bearer ', '');
        return token === 'access-bad'
          ? [500, 'boom']
          : [200, JSON.stringify(usageReply())];
      });

    const response = await request(server()).get('/limits');

    expect(response.status).toBe(200);
    const bad = response.body.accounts.find(a => a.label === 'bad@example.com');
    const good = response.body.accounts.find(a => a.label === 'good@example.com');
    expect(bad).toMatchObject({ ok: false, limits: [], credits: null });
    expect(bad.error).toMatch(/500/);
    expect(good).toMatchObject({ ok: true });
    expect(good.limits).toHaveLength(2);
  });

  it('does not need the proxy API key', async () => {
    process.env.PROXY_API_KEY = 'secret-key';
    addAccount('a');
    nock('https://api.anthropic.com').get('/api/oauth/usage').reply(200, usageReply());

    const response = await request(server()).get('/limits');

    expect(response.status).toBe(200);
    expect(response.body.accounts).toHaveLength(1);
  });

  it('always allows loopback, even when the allowlist names only the VPN', async () => {
    process.env.LIMITS_ALLOWLIST = '10.8.0.0/24';
    addAccount('a');
    nock('https://api.anthropic.com').get('/api/oauth/usage').reply(200, usageReply());

    // supertest connects over 127.0.0.1: an app on this machine must work
    // without the operator having to remember to list loopback.
    const response = await request(server()).get('/limits');

    expect(response.status).toBe(200);
  });

  it('refuses a socket address outside the allowlist', async () => {
    // No LIMITS_ALLOWLIST set: this is the shipped default, which must be
    // loopback only. A private range baked into the code would show up here as
    // a 200 and a wide allowlist in the refusal body.
    delete process.env.LIMITS_ALLOWLIST;
    addAccount('a');
    const scope = nock('https://api.anthropic.com').get('/api/oauth/usage').reply(200, usageReply());

    // Bind to this host's non-loopback address and connect to it, so the
    // server sees a real socket address outside both the VPN range and
    // loopback. A spoofed X-Forwarded-For must not change the outcome.
    const address = nonLoopbackAddress();
    if (!address) return;

    const listener = http.createServer(handleRequest);
    await new Promise(resolve => listener.listen(0, '0.0.0.0', resolve));
    try {
      const response = await new Promise((resolve, reject) => {
        const req = http.request({
          host: address,
          port: listener.address().port,
          path: '/limits',
          headers: { 'X-Forwarded-For': '10.8.0.5' }
        }, (res) => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      });

      expect(response.status).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/not allowed/);
      expect(body.allowlist).toEqual(['127.0.0.1/32', '::1/128']);
      expect(scope.isDone()).toBe(false);
    } finally {
      await new Promise(resolve => listener.close(resolve));
    }
  });

  it('serves the cached snapshot within the cache window', async () => {
    addAccount('a');
    const scope = nock('https://api.anthropic.com')
      .get('/api/oauth/usage')
      .once()
      .reply(200, usageReply());

    await request(server()).get('/limits');
    const second = await request(server()).get('/limits');

    expect(second.status).toBe(200);
    expect(scope.isDone()).toBe(true);
    // The second call was served from the in-process cache.
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('forces a fresh read with ?refresh=1', async () => {
    addAccount('a');
    nock('https://api.anthropic.com').get('/api/oauth/usage').reply(200, usageReply());
    nock('https://api.anthropic.com').get('/api/oauth/usage').reply(200, usageReply(50, 50));

    const first = await request(server()).get('/limits');
    const second = await request(server()).get('/limits').query({ refresh: 1 });

    expect(first.body.accounts[0].limits[0].percent_used).toBe(96);
    expect(second.body.accounts[0].limits[0].percent_used).toBe(50);
  });

  it('returns an empty array when no accounts are stored', async () => {
    const response = await request(server()).get('/limits');

    expect(response.status).toBe(200);
    expect(response.body.accounts).toEqual([]);
  });
});

describe('limit report routes', () => {
  const preview = (expression) => request(server())
    .get('/auth/settings/telegram/cron-preview')
    .query({ expression });

  it('describes a cron expression in plain Indonesian with its next run', async () => {
    const response = await preview('0 8 * * *');

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
    expect(response.body.description).toBe('Setiap hari pukul 08:00');
    expect(response.body.next_run).toMatch(/WIB$/);
  });

  it('rejects a malformed expression and explains why', async () => {
    const response = await preview('0 8 * *');

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(false);
    expect(response.body.error).toMatch(/5 fields/);
  });

  it('stores the limit fields and returns the schedule description', async () => {
    const response = await request(server())
      .post('/auth/settings/telegram')
      .send({
        bot_token: '123:abc',
        chat_id: '-100123',
        limit_alerts_enabled: false,
        limit_alert_threshold: 15,
        limit_report_cron: '30 7 * * 1-5'
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      limit_alerts_enabled: false,
      limit_alert_threshold: 15,
      limit_report_cron: '30 7 * * 1-5'
    });
    expect(response.body.schedule.valid).toBe(true);
    expect(response.body.schedule.description)
      .toBe('Setiap hari kerja (Senin–Jumat) pukul 07:30');
  });

  it('refuses to store a cron expression the scheduler could not run', async () => {
    const response = await request(server())
      .post('/auth/settings/telegram')
      .send({ bot_token: '123:abc', chat_id: '-100123', limit_report_cron: 'every day' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Invalid cron expression/);
    expect(fs.existsSync(TELEGRAM_PATH)).toBe(false);
  });

  it('validates the threshold range and the boolean flag', async () => {
    const threshold = await request(server())
      .post('/auth/settings/telegram')
      .send({ chat_id: '-100123', limit_alert_threshold: 0 });
    expect(threshold.status).toBe(400);
    expect(threshold.body)
      .toEqual({ error: 'limit_alert_threshold must be a number between 1 and 100' });

    const flag = await request(server())
      .post('/auth/settings/telegram')
      .send({ chat_id: '-100123', limit_alerts_enabled: 'yes' });
    expect(flag.status).toBe(400);
    expect(flag.body).toEqual({ error: 'limit_alerts_enabled must be a boolean' });
  });

  it('refuses a report before Telegram is configured', async () => {
    const response = await request(server()).post('/auth/settings/telegram/report');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Telegram is not configured' });
  });

  it('sends the report on demand and returns what went out', async () => {
    await request(server())
      .post('/auth/settings/telegram')
      .send({ bot_token: '123:abc', chat_id: '-100123' });
    OAuthManager.addAccount({
      access_token: 'access-a',
      refresh_token: 'refresh-a',
      expires_at: Date.now() + 3600000
    }, {
      account_uuid: 'uuid-a',
      organization_uuid: 'org-a',
      email: 'a@example.com'
    });

    const sent = [];
    nock('https://api.anthropic.com')
      .get('/api/oauth/usage')
      .reply(200, {
        limits: [{
          kind: 'session',
          percent: 12,
          severity: 'normal',
          resets_at: new Date(Date.now() + 3600000).toISOString()
        }]
      });
    nock('https://api.telegram.org')
      .post('/bot123:abc/sendMessage')
      .reply(200, function (uri, requestBody) {
        sent.push(requestBody.text);
        return { ok: true };
      });

    const response = await request(server()).post('/auth/settings/telegram/report');

    expect(response.status).toBe(200);
    expect(response.body.sent).toBe(true);
    expect(response.body.preview).toContain('Akun: a@example.com [aktif]');
    expect(sent[0]).toContain('5 jam');
  });

  it('rejects a cross-origin report', async () => {
    const response = await request(server())
      .post('/auth/settings/telegram/report')
      .set('Origin', 'http://evil.example');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Cross-origin request rejected' });
  });
});

describe('CORS headers', () => {
  it('includes CORS headers in all responses', async () => {
    const response = await request(server()).get('/auth/status');

    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toBe('GET, POST, PUT, DELETE, OPTIONS');
    expect(response.headers['access-control-allow-headers']).toBe('Content-Type, Authorization, X-Requested-With');
  });

  it('handles OPTIONS requests', async () => {
    const response = await request(server()).options('/auth/status');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('telegram settings routes', () => {
  const save = (body) => request(server()).post('/auth/settings/telegram').send(body);
  const storedSettings = () => JSON.parse(fs.readFileSync(TELEGRAM_PATH, 'utf8'));

  it('reports nothing configured before the first save', async () => {
    const response = await request(server()).get('/auth/settings/telegram');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      chat_id: '',
      silent_models: [],
      limit_alerts_enabled: true,
      limit_alert_threshold: 10,
      limit_report_cron: '',
      bot_token_set: false,
      configured: false,
      schedule: { valid: true }
    });
  });

  it('stores the token and chat id without echoing the token', async () => {
    const response = await save({ bot_token: '123:abc', chat_id: '-100123' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      chat_id: '-100123',
      silent_models: [],
      limit_alerts_enabled: true,
      limit_alert_threshold: 10,
      limit_report_cron: '',
      bot_token_set: true,
      configured: true,
      schedule: { valid: true }
    });
    expect(storedSettings()).toEqual({
      bot_token: '123:abc',
      chat_id: '-100123',
      silent_models: [],
      limit_alerts_enabled: true,
      limit_alert_threshold: 10,
      limit_report_cron: ''
    });
    expect(fs.statSync(TELEGRAM_PATH).mode & 0o777).toBe(0o600);
  });

  it('keeps the stored token when a later save leaves it out', async () => {
    await save({ bot_token: '123:abc', chat_id: '-100123' });

    const response = await save({ chat_id: '-100456' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      chat_id: '-100456',
      silent_models: [],
      limit_alerts_enabled: true,
      limit_alert_threshold: 10,
      limit_report_cron: '',
      bot_token_set: true,
      configured: true,
      schedule: { valid: true }
    });
    expect(storedSettings()).toEqual({
      bot_token: '123:abc',
      chat_id: '-100456',
      silent_models: [],
      limit_alerts_enabled: true,
      limit_alert_threshold: 10,
      limit_report_cron: ''
    });
  });

  it('turns notifications off when the chat id is emptied', async () => {
    await save({ bot_token: '123:abc', chat_id: '-100123' });

    const response = await save({ chat_id: '' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      chat_id: '',
      silent_models: [],
      limit_alerts_enabled: true,
      limit_alert_threshold: 10,
      limit_report_cron: '',
      bot_token_set: true,
      configured: false,
      schedule: { valid: true }
    });
    expect(storedSettings().chat_id).toBe('');
  });

  it('stores a forum topic chat id unchanged', async () => {
    const response = await save({ bot_token: '123:abc', chat_id: '-100123:534' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      chat_id: '-100123:534',
      silent_models: [],
      limit_alerts_enabled: true,
      limit_alert_threshold: 10,
      limit_report_cron: '',
      bot_token_set: true,
      configured: true,
      schedule: { valid: true }
    });
    expect(storedSettings().chat_id).toBe('-100123:534');
  });

  it('rejects a malformed topic suffix instead of posting to the wrong place', async () => {
    const response = await save({ bot_token: '123:abc', chat_id: '-100123:main' });

    expect(response.status).toBe(400);
    expect(response.body)
      .toEqual({ error: 'chat_id must be a numeric id or @channel, optionally with :topic' });
    expect(fs.existsSync(TELEGRAM_PATH)).toBe(false);
  });

  it('rejects a token with no colon and writes nothing', async () => {
    const response = await save({ bot_token: 'nocolon', chat_id: '-100123' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'bot_token is not a valid Telegram bot token' });
    expect(fs.existsSync(TELEGRAM_PATH)).toBe(false);
  });

  it('rejects a non-string token or chat id', async () => {
    const token = await save({ bot_token: 123, chat_id: '-100123' });
    expect(token.status).toBe(400);
    expect(token.body).toEqual({ error: 'bot_token must be a string' });

    const chat = await save({ chat_id: 100123 });
    expect(chat.status).toBe(400);
    expect(chat.body).toEqual({ error: 'chat_id must be a string' });

    const missing = await request(server()).post('/auth/settings/telegram').send({});
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: 'chat_id must be a string' });
  });

  it('rejects whitespace inside a chat id', async () => {
    const response = await save({ bot_token: '123:abc', chat_id: '-100 123' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'chat_id must not contain whitespace' });
    expect(fs.existsSync(TELEGRAM_PATH)).toBe(false);
  });

  it('normalizes silent models and stores them with the settings', async () => {
    const response = await save({
      bot_token: '123:abc',
      chat_id: '-100123',
      silent_models: [' Haiku ', 'HAIKU', '']
    });

    expect(response.status).toBe(200);
    expect(response.body.silent_models).toEqual(['haiku']);
    expect(storedSettings().silent_models).toEqual(['haiku']);
  });

  it('clears the stored silent models when an empty array is saved', async () => {
    await save({ bot_token: '123:abc', chat_id: '-100123', silent_models: ['haiku'] });

    const response = await save({ chat_id: '-100123', silent_models: [] });

    expect(response.status).toBe(200);
    expect(response.body.silent_models).toEqual([]);
    expect(storedSettings().silent_models).toEqual([]);
  });

  it('keeps the stored silent models when a later save omits them', async () => {
    await save({ bot_token: '123:abc', chat_id: '-100123', silent_models: ['haiku'] });

    const response = await save({ chat_id: '-100456' });

    expect(response.status).toBe(200);
    expect(response.body.silent_models).toEqual(['haiku']);
    expect(storedSettings()).toEqual({
      bot_token: '123:abc',
      chat_id: '-100456',
      silent_models: ['haiku'],
      limit_alerts_enabled: true,
      limit_alert_threshold: 10,
      limit_report_cron: ''
    });
  });

  it('rejects a non-array silent models field and writes nothing', async () => {
    const response = await save({ bot_token: '123:abc', chat_id: '-100123', silent_models: 'haiku' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'silent_models must be an array of strings' });
    expect(fs.existsSync(TELEGRAM_PATH)).toBe(false);
  });

  it('rejects an array containing a non-string silent model and writes nothing', async () => {
    const response = await save({
      bot_token: '123:abc',
      chat_id: '-100123',
      silent_models: ['haiku', 5]
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'silent_models must be an array of strings' });
    expect(fs.existsSync(TELEGRAM_PATH)).toBe(false);
  });

  it('rejects a malformed JSON body', async () => {
    const response = await request(server())
      .post('/auth/settings/telegram')
      .set('Content-Type', 'application/json')
      .send('{broken');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Invalid JSON/);
  });

  it('rejects a cross-origin save and writes nothing', async () => {
    const response = await request(server())
      .post('/auth/settings/telegram')
      .set('Origin', 'http://evil.example')
      .send({ bot_token: '123:abc', chat_id: '-100123' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Cross-origin request rejected' });
    expect(fs.existsSync(TELEGRAM_PATH)).toBe(false);
  });

  it('accepts a same-origin save', async () => {
    const response = await request(server())
      .post('/auth/settings/telegram')
      .set('Host', 'proxy.test')
      .set('Origin', 'http://proxy.test')
      .send({ bot_token: '123:abc', chat_id: '-100123' });

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(true);
  });
});
