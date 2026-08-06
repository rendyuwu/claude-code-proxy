const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
  getValidAccessToken: jest.fn().mockResolvedValue('stored-access-token'),
  refreshAccessToken: jest.fn().mockResolvedValue({ access_token: 'refreshed-access-token' }),
  getTokenExpiration: jest.fn().mockReturnValue(new Date(Date.now() + 3600000))
}));

const OAuthManager = require('./OAuthManager');
const ClaudeRequest = require('./ClaudeRequest');

const SONNET = 'claude-sonnet-4-5-20250929';
const HAIKU = 'claude-haiku-4-5-20251001';

// Minimal stand-in for server.js's /v1/messages route so the response path
// (status, headers, body framing) is exercised for real.
function messagesServer() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      const preset = req.headers['x-test-preset'] || null;
      await new ClaudeRequest(req).handleResponse(res, body, preset);
    });
  });
}

beforeAll(() => {
  // Fail fast on an unmatched upstream call instead of waiting on the network.
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterAll(() => {
  nock.enableNetConnect();
});

beforeEach(() => {
  nock.cleanAll();
  jest.clearAllMocks();
  OAuthManager.isAuthenticated.mockReturnValue(true);
  OAuthManager.getValidAccessToken.mockResolvedValue('stored-access-token');
  OAuthManager.refreshAccessToken.mockResolvedValue({ access_token: 'refreshed-access-token' });
  OAuthManager.getTokenExpiration.mockReturnValue(new Date(Date.now() + 3600000));
});

afterEach(() => {
  jest.restoreAllMocks();
  nock.cleanAll();
});

describe('processRequestBody', () => {
  it('does not mutate the caller body', () => {
    const body = { model: SONNET, system: 'be terse', messages: [{ role: 'user', content: 'hi' }] };
    new ClaudeRequest().processRequestBody(body, 'pyrite');

    expect(body.system).toBe('be terse');
    expect(body.messages).toHaveLength(1);
  });

  it('produces the same payload when called twice with the same body (401 retry path)', () => {
    const claudeRequest = new ClaudeRequest();
    const body = { model: SONNET, system: 'be terse', messages: [{ role: 'user', content: 'hi' }] };

    const first = claudeRequest.processRequestBody(body, 'pyrite');
    const second = claudeRequest.processRequestBody(body, 'pyrite');

    expect(second).toEqual(first);
    expect(first.system.filter(s => s.text.startsWith('You are Claude Code'))).toHaveLength(1);
  });

  it('injects the Claude Code system prompt exactly once for non-Haiku models', () => {
    const processed = new ClaudeRequest().processRequestBody({
      model: SONNET,
      messages: [{ role: 'user', content: 'hi' }]
    });

    expect(processed.system).toEqual([
      { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' }
    ]);
  });

  it('skips the Claude Code system prompt for Haiku and leaves no system field behind', () => {
    const processed = new ClaudeRequest().processRequestBody({
      model: HAIKU,
      messages: [{ role: 'user', content: 'hi' }]
    });

    expect(processed.system).toBeUndefined();
  });

  it.each([
    ['no system field', undefined],
    ['string system', 'be terse'],
    ['array system', [{ type: 'text', text: 'be terse' }]]
  ])('applies a preset to a Haiku request with %s', (_label, system) => {
    const body = { model: HAIKU, messages: [{ role: 'user', content: 'hi' }] };
    if (system !== undefined) body.system = system;

    const processed = new ClaudeRequest().processRequestBody(body, 'pyrite');

    expect(Array.isArray(processed.system)).toBe(true);
    expect(processed.system.length).toBeGreaterThan(0);
    expect(processed.system.every(block => block.type === 'text')).toBe(true);
    // Preset injects a suffix user turn, and no Claude Code prompt for Haiku.
    expect(processed.messages).toHaveLength(2);
    expect(processed.system.some(block => block.text.startsWith('You are Claude Code'))).toBe(false);
  });

  it('normalizes a string system field for non-Haiku models', () => {
    const processed = new ClaudeRequest().processRequestBody({
      model: SONNET,
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }]
    });

    expect(processed.system).toEqual([
      { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
      { type: 'text', text: 'be terse' }
    ]);
  });
});

describe('token handling', () => {
  it('keeps an x-api-key token on the instance instead of a shared cache', async () => {
    const withKey = new ClaudeRequest({ headers: { 'x-api-key': 'sk-ant-oat01-CLIENT-A' } });
    const withoutKey = new ClaudeRequest({ headers: {} });

    await expect(withKey.getAuthToken()).resolves.toBe('Bearer sk-ant-oat01-CLIENT-A');
    expect(withoutKey.headerToken).toBeNull();
    await expect(withoutKey.getAuthToken()).resolves.toBe('Bearer stored-access-token');
  });

  it('forces a refresh when asked instead of returning the token that was just rejected', async () => {
    const token = await new ClaudeRequest().loadOrRefreshToken({ force: true });

    expect(OAuthManager.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(OAuthManager.getValidAccessToken).not.toHaveBeenCalled();
    expect(token).toBe('Bearer refreshed-access-token');
  });

  it('reports missing credentials as a 401, not a 500', async () => {
    OAuthManager.isAuthenticated.mockReturnValue(false);
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-home-'));
    jest.spyOn(os, 'homedir').mockReturnValue(emptyHome);

    await expect(new ClaudeRequest().getAuthToken()).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('Claude Code credential fallback', () => {
  let fakeHome;
  let credentialsPath;

  const writeCredentials = (expiresAt) => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-home-'));
    fs.mkdirSync(path.join(fakeHome, '.claude'));
    credentialsPath = path.join(fakeHome, '.claude', '.credentials.json');
    fs.writeFileSync(credentialsPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'claude-code-access-token',
        refreshToken: 'claude-code-refresh-token',
        expiresAt
      }
    }));
    jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  };

  beforeEach(() => {
    OAuthManager.isAuthenticated.mockReturnValue(false);
  });

  it('uses a valid Claude Code access token', async () => {
    writeCredentials(Date.now() + 3600000);

    await expect(new ClaudeRequest().getAuthToken()).resolves.toBe('Bearer claude-code-access-token');
  });

  it('never writes to the Claude Code credentials file when the token is expired', async () => {
    writeCredentials(Date.now() - 1000);
    const before = fs.readFileSync(credentialsPath, 'utf8');
    const writeSpy = jest.spyOn(fs, 'writeFileSync');

    await expect(new ClaudeRequest().getAuthToken()).rejects.toThrow(/expired/);

    expect(writeSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(credentialsPath, 'utf8')).toBe(before);
  });

  it('never refreshes the shared credentials file even when a 401 forces a refresh', async () => {
    writeCredentials(Date.now() + 3600000);
    const writeSpy = jest.spyOn(fs, 'writeFileSync');

    await expect(new ClaudeRequest().loadOrRefreshToken({ force: true })).rejects.toThrow(/expired/);

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('describes the credential source so startup can report it accurately', () => {
    writeCredentials(Date.now() + 3600000);

    expect(ClaudeRequest.describeCredentialSource()).toMatchObject({
      source: 'claude-code',
      expired: false
    });

    OAuthManager.isAuthenticated.mockReturnValue(true);
    expect(ClaudeRequest.describeCredentialSource()).toMatchObject({ source: 'proxy' });
  });

  it('reports no credentials when the file is missing', () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-home-'));
    jest.spyOn(os, 'homedir').mockReturnValue(emptyHome);

    expect(ClaudeRequest.describeCredentialSource()).toEqual({ source: 'none' });
  });
});

describe('presets', () => {
  it('recognizes a preset that exists', () => {
    expect(ClaudeRequest.presetExists('pyrite')).toBe(true);
  });

  it('rejects unknown names and path traversal attempts', () => {
    expect(ClaudeRequest.presetExists('nosuch')).toBe(false);
    expect(ClaudeRequest.presetExists('../config')).toBe(false);
  });

  it('lists available presets', () => {
    expect(ClaudeRequest.availablePresets()).toContain('pyrite');
  });
});

describe('response forwarding', () => {
  it('retries a 401 once with a refreshed token and sends an identical body', async () => {
    const sentBodies = [];
    const capture = (body) => { sentBodies.push(body); return true; };

    nock('https://api.anthropic.com').post('/v1/messages', capture).reply(401, { error: 'expired' });
    nock('https://api.anthropic.com').post('/v1/messages', capture).reply(200, { ok: true });

    const response = await request(messagesServer())
      .post('/v1/messages')
      .set('x-test-preset', 'pyrite')
      .send({ model: SONNET, system: 'be terse', messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    expect(OAuthManager.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[1]).toEqual(sentBodies[0]);
    expect(sentBodies[1].system.filter(s => s.text.startsWith('You are Claude Code'))).toHaveLength(1);
    expect(sentBodies[1].messages).toHaveLength(2);
  });

  it('passes a 401 straight through for a client-supplied x-api-key', async () => {
    const scope = nock('https://api.anthropic.com')
      .post('/v1/messages')
      .reply(401, { error: 'invalid token' });

    const response = await request(messagesServer())
      .post('/v1/messages')
      .set('x-api-key', 'sk-ant-oat01-BOGUS')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(401);
    expect(OAuthManager.refreshAccessToken).not.toHaveBeenCalled();
    expect(scope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('sets content-length from the bytes it actually writes and drops upstream framing headers', async () => {
    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .reply(200, JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'hi' }] }), {
        'content-type': 'application/json',
        // Deliberately wrong: the proxy re-serializes the body, so forwarding
        // upstream's framing headers would misframe the response.
        'content-length': '999999',
        'transfer-encoding': 'chunked',
        'anthropic-ratelimit-requests-remaining': '42'
      });

    const response = await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['transfer-encoding']).toBeUndefined();
    expect(Number(response.headers['content-length'])).toBe(Buffer.byteLength(response.text));
    // Non-framing upstream headers still reach the client.
    expect(response.headers['anthropic-ratelimit-requests-remaining']).toBe('42');
  });

  it('returns the auth failure status when no credential can be obtained', async () => {
    OAuthManager.isAuthenticated.mockReturnValue(false);
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-home-'));
    jest.spyOn(os, 'homedir').mockReturnValue(emptyHome);

    const response = await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/credentials/i);
  });
});

describe('GET /v1/models forwarding', () => {
  it('forwards the upstream model list', async () => {
    nock('https://api.anthropic.com')
      .get('/v1/models')
      .reply(200, { data: [{ id: 'claude-opus-5' }] });

    const server = http.createServer(async (req, res) => {
      await new ClaudeRequest(req).handleModels(res, '');
    });

    const response = await request(server).get('/v1/models');

    expect(response.status).toBe(200);
    expect(response.body.data[0].id).toBe('claude-opus-5');
  });
});
