// Route-level tests that drive the real handleRequest from server.js, rather
// than a copy of its logic.
const http = require('http');
const fs = require('fs');
const nock = require('nock');
const request = require('supertest');

jest.mock('./Logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  init: jest.fn(),
  getLogLevel: jest.fn().mockReturnValue(0),
  createDebugStream: jest.fn()
}));

jest.mock('./OAuthManager', () => ({
  isAuthenticated: jest.fn().mockReturnValue(true),
  getActiveAccount: jest.fn(() => ({ id: 'acct-1', label: 'Account 1' })),
  getValidAccessToken: jest.fn().mockResolvedValue('stored-access-token'),
  refreshAccessToken: jest.fn().mockResolvedValue({ access_token: 'refreshed-access-token' }),
  accountCount: jest.fn().mockReturnValue(1),
  markAccountLimited: jest.fn().mockReturnValue(null),
  getEarliestResetMs: jest.fn().mockReturnValue(null),
  getStatus: jest.fn(() => ({
    authenticated: true,
    active_account_id: 'acct-1',
    all_limited: false,
    earliest_reset_at: null,
    accounts: [{
      id: 'acct-1',
      label: 'Account 1',
      email: null,
      expires_at: Date.now() + 3600000,
      limited_until: null,
      limited: false,
      limited_reason: null,
      active: true
    }]
  })),
  generatePKCE: jest.fn(),
  buildAuthorizationURL: jest.fn(),
  exchangeCodeForTokens: jest.fn(),
  addAccountFromTokenResponse: jest.fn().mockResolvedValue({ id: 'acct-1', label: 'Account 1' }),
  disableAccount: jest.fn(() => ({ accounts: [] })),
  activateAccount: jest.fn(() => ({ accounts: [] })),
  deleteAccount: jest.fn(() => ({ accounts: [] })),
  logout: jest.fn()
}));

const OAuthManager = require('./OAuthManager');
const { handleRequest } = require('./server');

const SONNET = 'claude-sonnet-4-5-20250929';
const server = () => http.createServer(handleRequest);

beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterAll(() => {
  nock.enableNetConnect();
});

beforeEach(() => {
  nock.cleanAll();
  jest.clearAllMocks();
});

describe('POST /v1/:preset/messages', () => {
  it('rejects an unknown preset with 400 and lists the real ones', async () => {
    const response = await request(server())
      .post('/v1/nosuch/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Unknown preset: nosuch/);
    expect(response.body.available_presets).toContain('pyrite');
    // Nothing was forwarded upstream.
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('forwards a known preset', async () => {
    const scope = nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(200, JSON.stringify({ id: 'msg_1' }), { 'content-type': 'application/json' });

    const response = await request(server())
      .post('/v1/pyrite/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    expect(scope.isDone()).toBe(true);
  });
});

describe('POST /v1/messages', () => {
  it('answers 400 for a malformed JSON body', async () => {
    const response = await request(server())
      .post('/v1/messages')
      .set('Content-Type', 'application/json')
      .send('{broken');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Invalid JSON/);
  });
});

describe('GET /v1/models', () => {
  it('forwards the upstream model list', async () => {
    nock('https://api.anthropic.com')
      .get('/v1/models')
      .reply(200, JSON.stringify({ data: [{ id: 'claude-opus-5' }] }), {
        'content-type': 'application/json'
      });

    const response = await request(server()).get('/v1/models');

    expect(response.status).toBe(200);
    expect(response.body.data[0].id).toBe('claude-opus-5');
  });

  it('passes the query string through', async () => {
    const scope = nock('https://api.anthropic.com')
      .get('/v1/models')
      .query({ limit: '2' })
      .reply(200, JSON.stringify({ data: [] }), { 'content-type': 'application/json' });

    const response = await request(server()).get('/v1/models?limit=2');

    expect(response.status).toBe(200);
    expect(scope.isDone()).toBe(true);
  });
});

describe('client API key gate', () => {
  const KEY = 'sk-proxy-secret';

  beforeEach(() => {
    process.env.PROXY_API_KEY = KEY;
  });

  afterEach(() => {
    delete process.env.PROXY_API_KEY;
  });

  const upstream = () => nock('https://api.anthropic.com')
    .post('/v1/messages')
    .query({ beta: 'true' })
    .reply(200, JSON.stringify({ id: 'msg_1' }), { 'content-type': 'application/json' });

  it('401s /v1/messages with no key and forwards nothing', async () => {
    const response = await request(server())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(401);
    expect(response.body.error.type).toBe('authentication_error');
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('401s a wrong key, including one of the same length', async () => {
    const response = await request(server())
      .post('/v1/messages')
      .set('x-api-key', 'sk-proxy-secreT')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(401);
  });

  it('accepts Authorization: Bearer', async () => {
    const scope = upstream();

    const response = await request(server())
      .post('/v1/messages')
      .set('Authorization', `Bearer ${KEY}`)
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    expect(scope.isDone()).toBe(true);
  });

  it('accepts x-api-key and does not spend it upstream as a token', async () => {
    let sentAuth;
    const scope = nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(function () {
        sentAuth = this.req.headers.authorization;
        return [200, JSON.stringify({ id: 'msg_1' }), { 'content-type': 'application/json' }];
      });

    const response = await request(server())
      .post('/v1/messages')
      .set('x-api-key', KEY)
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    expect(scope.isDone()).toBe(true);
    // The stored OAuth token, not the proxy password.
    expect(sentAuth).toBe('Bearer stored-access-token');
  });

  it('gates /v1/models too', async () => {
    const response = await request(server()).get('/v1/models');

    expect(response.status).toBe(401);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('leaves /health open', async () => {
    const response = await request(server()).get('/health');

    expect(response.status).toBe(200);
  });

  it('lets a loopback browser reach /auth/status without the key', async () => {
    const response = await request(server()).get('/auth/status');

    expect(response.status).toBe(200);
  });
});

describe('Docker host browser', () => {
  const KEY = 'sk-proxy-secret';
  const GATEWAY = '172.21.0.1';
  const ROUTE_TABLE = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t08080808\t010A0A0A\t0007\t0\t0\t0\tFFFFFFFF\t0\t0\t0',
    'eth0\t00000000\t010015AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    ''
  ].join('\n');

  const realFs = jest.requireActual('fs');

  // Only the socket address is faked: the request still goes through the real
  // handleRequest, so this covers the key gate itself, not a copy of it.
  const serverAs = (remoteAddress) => http.createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true });
    handleRequest(req, res);
  });

  const setInDocker = (running) => {
    jest.spyOn(fs, 'existsSync')
      .mockImplementation(file => (file === '/.dockerenv' ? running : realFs.existsSync(file)));
    jest.spyOn(fs, 'readFileSync').mockImplementation((file, encoding) => {
      if (file === '/proc/net/route') return ROUTE_TABLE;
      if (file === '/proc/self/cgroup') return '0::/init.scope';
      return realFs.readFileSync(file, encoding);
    });
  };

  beforeEach(() => {
    process.env.PROXY_API_KEY = KEY;
    setInDocker(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.PROXY_API_KEY;
  });

  it('serves /auth/login to a browser on the host without the key', async () => {
    const response = await request(serverAs(GATEWAY)).get('/auth/login');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('still gates a LAN address that is not the gateway', async () => {
    const response = await request(serverAs('192.168.1.50')).get('/auth/status');

    expect(response.status).toBe(401);
  });

  it('gates the gateway address when not running in Docker', async () => {
    setInDocker(false);

    const response = await request(serverAs(GATEWAY)).get('/auth/status');

    expect(response.status).toBe(401);
  });
});

describe('auth routes switch', () => {
  afterEach(() => {
    delete process.env.AUTH_ROUTES_ENABLED;
    delete process.env.PROXY_API_KEY;
  });

  it('serves /auth/* by default', async () => {
    const response = await request(server()).get('/auth/status');

    expect(response.status).toBe(200);
  });

  it('404s every /auth route when disabled, loopback included', async () => {
    process.env.AUTH_ROUTES_ENABLED = 'false';

    for (const route of ['/auth/status', '/auth/accounts', '/auth/login', '/auth/get-url', '/auth/logout']) {
      const response = await request(server()).get(route);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Not found');
    }

    // The account mutations live under /auth/* too, so they are just as gone.
    const mutation = await request(server()).post('/auth/accounts/x/disable');

    expect(mutation.status).toBe(404);
    expect(OAuthManager.disableAccount).not.toHaveBeenCalled();
  });

  it('does not log out when disabled', async () => {
    process.env.AUTH_ROUTES_ENABLED = 'false';

    await request(server()).get('/auth/logout');

    expect(OAuthManager.logout).not.toHaveBeenCalled();
  });

  it('404s rather than 401s when the key gate is also on', async () => {
    process.env.AUTH_ROUTES_ENABLED = 'false';
    process.env.PROXY_API_KEY = 'sk-proxy-secret';

    const response = await request(server()).get('/auth/status');

    // 401 would confirm the route exists behind a key.
    expect(response.status).toBe(404);
  });

  it('keeps serving /v1 when auth routes are off', async () => {
    process.env.AUTH_ROUTES_ENABLED = 'false';
    const scope = nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(200, JSON.stringify({ id: 'msg_1' }), { 'content-type': 'application/json' });

    const response = await request(server())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    expect(scope.isDone()).toBe(true);
  });
});

describe('account management routes', () => {
  it('rejects a cross-origin mutation and calls nothing', async () => {
    const response = await request(server())
      .post('/auth/accounts/x/disable')
      .set('Origin', 'http://evil.example');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Cross-origin request rejected' });
    expect(OAuthManager.disableAccount).not.toHaveBeenCalled();
  });

  it('accepts a same-origin mutation and one with no Origin header', async () => {
    const sameOrigin = await request(server())
      .post('/auth/accounts/x/disable')
      .set('Host', 'proxy.test')
      .set('Origin', 'http://proxy.test');

    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.body.accounts).toHaveLength(1);

    const headerless = await request(server()).post('/auth/accounts/x/disable');

    expect(headerless.status).toBe(200);
    expect(OAuthManager.disableAccount).toHaveBeenCalledTimes(2);
    expect(OAuthManager.disableAccount).toHaveBeenCalledWith('x');
  });

  it('404s a malformed account id instead of calling the manager', async () => {
    const response = await request(server()).post('/auth/accounts/%ZZ/disable');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Account not found' });
    expect(OAuthManager.disableAccount).not.toHaveBeenCalled();
  });

  it('500s with a JSON body when the manager throws', async () => {
    OAuthManager.disableAccount.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const response = await request(server()).post('/auth/accounts/x/disable');

    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({ error: 'Failed to update account' });
  });

  it('404s an unknown account and reports the manager status otherwise', async () => {
    OAuthManager.deleteAccount.mockReturnValueOnce(null);

    const missing = await request(server()).delete('/auth/accounts/x');

    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Account not found' });

    const deleted = await request(server()).delete('/auth/accounts/x');

    expect(deleted.status).toBe(200);
    expect(OAuthManager.deleteAccount).toHaveBeenCalledTimes(2);
  });
});

describe('other routes', () => {
  it('serves /health', async () => {
    const response = await request(server()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('404s an unknown path', async () => {
    const response = await request(server()).get('/nope');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Not found');
  });
});
