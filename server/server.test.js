// Route-level tests that drive the real handleRequest with the real
// OAuthManager, pointed at a temporary account store.
const http = require('http');
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
const { handleRequest } = require('./server');

const TEST_DIR = path.join(__dirname, '.test-server-accounts');
const STATE_PATH = path.join(TEST_DIR, 'accounts.json');
const TOKEN_PATH = path.join(TEST_DIR, 'tokens.json');

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
  nock.enableNetConnect('127.0.0.1');
});

afterAll(() => {
  nock.enableNetConnect();
});

beforeEach(() => {
  nock.cleanAll();
  OAuthManager.statePath = STATE_PATH;
  OAuthManager.tokenPath = TOKEN_PATH;
  OAuthManager.refreshPromises.clear();

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
            'anthropic-ratelimit-unified-reset': String(resetSec)
          }
        ];
      });

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(function () {
        authorizations.push(this.req.headers.authorization);
        return [200, JSON.stringify({ id: 'msg_2' }), { 'content-type': 'application/json' }];
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
