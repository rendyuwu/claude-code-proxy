const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { PassThrough } = require('stream');
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

jest.mock('./OAuthManager', () => {
  const account = () => ({
    id: 'acct-1',
    label: 'Account 1',
    email: null,
    expires_at: Date.now() + 3600000,
    limited_until: null,
    limited: false,
    limited_reason: null,
    active: true
  });

  return {
    isAuthenticated: jest.fn().mockReturnValue(true),
    getActiveAccount: jest.fn(() => ({ id: 'acct-1', label: 'Account 1' })),
    getValidAccessToken: jest.fn().mockResolvedValue('stored-access-token'),
    refreshAccessToken: jest.fn().mockResolvedValue({ access_token: 'refreshed-access-token' }),
    accountCount: jest.fn().mockReturnValue(1),
    markAccountLimited: jest.fn().mockReturnValue(null),
    recordFiveHourReset: jest.fn(),
    getEarliestResetMs: jest.fn().mockReturnValue(null),
    getStatus: jest.fn(() => ({
      authenticated: true,
      active_account_id: 'acct-1',
      all_limited: false,
      earliest_reset_at: null,
      accounts: [account()]
    }))
  };
});

const OAuthManager = require('./OAuthManager');
const ClaudeRequest = require('./ClaudeRequest');
const Telegram = require('./Telegram');
const CacheWatch = require('./CacheWatch');

const SONNET = 'claude-sonnet-4-5-20250929';
const HAIKU = 'claude-haiku-4-5-20251001';
const FABLE = 'claude-fable-5-1';

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
  // A response with cache usage now notifies Telegram; keep the host's real
  // settings file and the network out of the unit tests.
  jest.spyOn(Telegram, 'send').mockResolvedValue(true);
  jest.spyOn(Telegram, 'isModelSilenced').mockReturnValue(false);
  CacheWatch.reset();
  OAuthManager.isAuthenticated.mockReturnValue(true);
  OAuthManager.getActiveAccount.mockReturnValue({ id: 'acct-1', label: 'Account 1' });
  OAuthManager.getValidAccessToken.mockResolvedValue('stored-access-token');
  OAuthManager.refreshAccessToken.mockResolvedValue({ access_token: 'refreshed-access-token' });
  OAuthManager.accountCount.mockReturnValue(1);
  OAuthManager.markAccountLimited.mockReturnValue(null);
  OAuthManager.getEarliestResetMs.mockReturnValue(null);
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

  it.each([
    ['Sonnet', SONNET],
    ['Haiku', HAIKU]
  ])('injects the Claude Code system prompt exactly once for %s', (_label, model) => {
    const processed = new ClaudeRequest().processRequestBody({
      model,
      messages: [{ role: 'user', content: 'hi' }]
    });

    expect(processed.system).toEqual([
      { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' }
    ]);
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
    expect(processed.system.every(block => block.type === 'text')).toBe(true);
    // Preset injects a suffix user turn.
    expect(processed.messages).toHaveLength(2);
    expect(processed.system[0].text).toMatch(/^You are Claude Code/);
  });

  it('normalizes a string system field', () => {
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

describe('sampling parameters', () => {
  // Front ends send these on every request, and the models this proxy is used
  // with answer 400 "`x` is deprecated for this model": top_k on every Claude 5,
  // temperature and top_p from claude-opus-4-7 onward. Verified live against
  // api.anthropic.com.
  it.each([
    ['zero', 'top_k', 0],
    ['non-zero', 'top_k', 40],
    ['default', 'temperature', 1],
    ['non-default', 'temperature', 0.7],
    ['default', 'top_p', 1],
    ['non-default', 'top_p', 0.95]
  ])('drops a %s %s', (_label, param, value) => {
    const processed = new ClaudeRequest().processRequestBody({
      model: FABLE,
      [param]: value,
      messages: [{ role: 'user', content: 'hi' }]
    });

    expect(processed).not.toHaveProperty(param);
  });

  it('drops every sampling parameter when the client sends all three', () => {
    const processed = new ClaudeRequest().processRequestBody({
      model: FABLE,
      top_k: 0,
      temperature: 0.7,
      top_p: 0.95,
      messages: [{ role: 'user', content: 'hi' }]
    });

    expect(processed).not.toHaveProperty('top_k');
    expect(processed).not.toHaveProperty('temperature');
    expect(processed).not.toHaveProperty('top_p');
  });

  it('leaves the caller body untouched when stripping sampling parameters', () => {
    const body = {
      model: FABLE,
      top_k: 0,
      temperature: 0.7,
      top_p: 0.95,
      messages: [{ role: 'user', content: 'hi' }]
    };
    new ClaudeRequest().processRequestBody(body);

    expect(body.top_k).toBe(0);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.95);
  });
});

describe('prompt caching', () => {
  const withTtl = () => ({
    model: SONNET,
    tools: [{ name: 't', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    system: [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] }]
  });

  it('keeps cache_control.ttl by default so a 1h breakpoint is not downgraded to 5m', () => {
    const processed = new ClaudeRequest().processRequestBody(withTtl());

    expect(processed.tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(processed.system[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(processed.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('strips ttl and scope from every cache_control site, tools included, when asked', () => {
    const body = withTtl();
    body.system[0].cache_control.scope = 'organization';

    const stripped = new ClaudeRequest().stripTtlFromCacheControl(body);

    expect(stripped.tools[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(stripped.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(stripped.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('hands the trailing system breakpoint to the preset block so the preset is cached', () => {
    const processed = new ClaudeRequest().processRequestBody({
      model: SONNET,
      system: [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }]
    }, 'pyrite');

    const last = processed.system[processed.system.length - 1];
    expect(processed.system).toHaveLength(3); // Claude Code, client, preset
    expect(last.text).not.toBe('be terse');
    expect(last.cache_control).toEqual({ type: 'ephemeral' });
    expect(processed.system[1].cache_control).toBeUndefined();
  });

  it('hands the trailing message breakpoint to the injected suffix turn', () => {
    const processed = new ClaudeRequest().processRequestBody({
      model: SONNET,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: [{ type: 'text', text: 'again', cache_control: { type: 'ephemeral' } }] }
      ]
    }, 'pyrite');

    const suffix = processed.messages[3];
    expect(suffix.role).toBe('user');
    expect(suffix.content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(processed.messages[2].content[0].cache_control).toBeUndefined();
  });

  it('does not invent a breakpoint when the client set none', () => {
    const processed = new ClaudeRequest().processRequestBody({
      model: SONNET,
      system: [{ type: 'text', text: 'be terse' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    }, 'pyrite');

    const blocks = [...processed.system, ...processed.messages.flatMap(m => m.content)];
    expect(blocks.every(block => block.cache_control === undefined)).toBe(true);
  });

  it('still produces an identical payload on the 401 retry path', () => {
    const claudeRequest = new ClaudeRequest();
    const body = {
      model: SONNET,
      system: [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }]
    };

    expect(claudeRequest.processRequestBody(body, 'pyrite'))
      .toEqual(claudeRequest.processRequestBody(body, 'pyrite'));
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
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

    nock('https://api.anthropic.com').post('/v1/messages', capture).query({ beta: 'true' }).reply(401, { error: 'expired' });
    nock('https://api.anthropic.com').post('/v1/messages', capture).query({ beta: 'true' }).reply(200, { ok: true });

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
      .query({ beta: 'true' })
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
      .query({ beta: 'true' })
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

describe('429 failover', () => {
  const rateLimited = (authorizations, resetSec) => {
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
            'anthropic-ratelimit-unified-status': 'rejected',
            'anthropic-ratelimit-unified-reset': String(resetSec),
            'anthropic-ratelimit-unified-5h-reset': String(resetSec)
          }
        ];
      });
  };

  const ok = (authorizations) => {
    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(function () {
        authorizations.push(this.req.headers.authorization);
        return [200, JSON.stringify({ id: 'msg_2' }), { 'content-type': 'application/json' }];
      });
  };

  it('retries the same request on the next account with its own token', async () => {
    const authorizations = [];
    const resetSec = Math.floor(Date.now() / 1000) + 3600;

    OAuthManager.getActiveAccount
      .mockReturnValueOnce({ id: 'a1', label: 'Account A' })
      .mockReturnValueOnce({ id: 'a2', label: 'Account B' });
    OAuthManager.getValidAccessToken.mockImplementation(id => Promise.resolve(`token-${id}`));
    OAuthManager.accountCount.mockReturnValue(2);
    OAuthManager.markAccountLimited.mockReturnValue({ id: 'a2', label: 'Account B' });

    rateLimited(authorizations, resetSec);
    ok(authorizations);

    const response = await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe('msg_2');
    expect(authorizations).toEqual(['Bearer token-a1', 'Bearer token-a2']);
    expect(OAuthManager.markAccountLimited).toHaveBeenCalledTimes(1);
    expect(OAuthManager.markAccountLimited).toHaveBeenCalledWith('a1', {
      resetAtMs: resetSec * 1000,
      fiveHourResetAtMs: resetSec * 1000,
      reason: 'rate_limit'
    });
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('never fails over for a client-supplied x-api-key', async () => {
    const scope = nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(429, { type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } });

    const response = await request(messagesServer())
      .post('/v1/messages')
      .set('x-api-key', 'sk-ant-oat01-client')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(429);
    expect(response.body.error.type).toBe('rate_limit_error');
    expect(OAuthManager.markAccountLimited).not.toHaveBeenCalled();
    expect(scope.isDone()).toBe(true);
  });

  it('forwards the upstream 429 body once every account is limited', async () => {
    OAuthManager.accountCount.mockReturnValue(1);
    OAuthManager.markAccountLimited.mockReturnValue(null);

    const scope = nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(429, { type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } });

    const response = await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } });
    expect(OAuthManager.markAccountLimited).toHaveBeenCalledTimes(1);
    expect(scope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('answers 429 with Retry-After without calling upstream when all accounts are limited', async () => {
    OAuthManager.getActiveAccount.mockReturnValue(null);
    OAuthManager.accountCount.mockReturnValue(2);
    OAuthManager.getEarliestResetMs.mockReturnValue(Date.now() + 60000);

    const response = await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(429);
    expect(response.body.error).toMatch(/All 2 OAuth accounts are rate limited/);
    expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(59);
    expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('stops at the last account and forwards that account 429', async () => {
    const authorizations = [];

    OAuthManager.getActiveAccount
      .mockReturnValueOnce({ id: 'a1', label: 'Account A' })
      .mockReturnValueOnce({ id: 'a2', label: 'Account B' });
    OAuthManager.getValidAccessToken.mockImplementation(id => Promise.resolve(`token-${id}`));
    OAuthManager.accountCount.mockReturnValue(2);
    OAuthManager.markAccountLimited
      .mockReturnValueOnce({ id: 'a2', label: 'Account B' })
      .mockReturnValueOnce(null);

    const limitedReply = (message) => nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(function () {
        authorizations.push(this.req.headers.authorization);
        return [
          429,
          JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message } }),
          { 'content-type': 'application/json' }
        ];
      });

    limitedReply('usage limit A');
    limitedReply('usage limit B');

    const response = await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(429);
    expect(response.body.error.message).toBe('usage limit B');
    expect(authorizations).toEqual(['Bearer token-a1', 'Bearer token-a2']);
    expect(OAuthManager.markAccountLimited).toHaveBeenCalledTimes(2);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does not build a date from an unusable reset value', () => {
    const error = new ClaudeRequest().rateLimitError(2, 1e17);

    expect(error.statusCode).toBe(429);
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.message).toBe('All 2 OAuth accounts are rate limited');
  });

  it('parses the reset headers', () => {
    expect(ClaudeRequest.limitResetAtMs({ 'anthropic-ratelimit-unified-reset': '1790000000' }))
      .toBe(1790000000000);
    expect(ClaudeRequest.limitResetAtMs({ 'anthropic-ratelimit-unified-reset': '1790000000000' }))
      .toBe(1790000000000);

    const before = Date.now();
    const fromSeconds = ClaudeRequest.limitResetAtMs({ 'retry-after': '30' });
    expect(fromSeconds).toBeGreaterThanOrEqual(before + 30000);
    expect(fromSeconds).toBeLessThanOrEqual(before + 31000);

    const httpDate = 'Wed, 21 Oct 2026 07:28:00 GMT';
    expect(ClaudeRequest.limitResetAtMs({ 'retry-after': httpDate })).toBe(Date.parse(httpDate));

    expect(ClaudeRequest.limitResetAtMs({})).toBeNull();
    expect(ClaudeRequest.limitResetAtMs(null)).toBeNull();
    expect(ClaudeRequest.limitResetAtMs({ 'retry-after': 'garbage' })).toBeNull();

    // The 5-hour window end is not the limit, so it never becomes a cooldown:
    // doing so benched a healthy account for up to the whole window.
    expect(ClaudeRequest.limitResetAtMs({ 'anthropic-ratelimit-unified-5h-reset': '1790000000' }))
      .toBeNull();

    // And a named cooldown still wins over the window end.
    const beforeRetry = Date.now();
    const fromRetryAfter = ClaudeRequest.limitResetAtMs({
      'retry-after': '30',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(beforeRetry / 1000) + 3600)
    });
    expect(fromRetryAfter).toBeLessThanOrEqual(beforeRetry + 31000);
  });

  it('parses the 5-hour window end from its own header or the representative claim', () => {
    expect(ClaudeRequest.fiveHourResetAtMs({ 'anthropic-ratelimit-unified-5h-reset': '1790000000' }))
      .toBe(1790000000000);
    expect(ClaudeRequest.fiveHourResetAtMs({
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-reset': '1790000000'
    })).toBe(1790000000000);

    expect(ClaudeRequest.fiveHourResetAtMs({})).toBeNull();
    expect(ClaudeRequest.fiveHourResetAtMs(null)).toBeNull();
    expect(ClaudeRequest.fiveHourResetAtMs({ 'anthropic-ratelimit-unified-5h-reset': 'garbage' })).toBeNull();
    expect(ClaudeRequest.fiveHourResetAtMs({
      'anthropic-ratelimit-unified-representative-claim': 'seven_day',
      'anthropic-ratelimit-unified-reset': '1790000000'
    })).toBeNull();
  });
});

describe('client identity headers', () => {
  it('presents itself as the Claude Code CLI that owns the credential', () => {
    const headers = new ClaudeRequest().getHeaders('Bearer token');

    expect(headers['User-Agent']).toBe('claude-cli/2.1.280 (external, sdk-cli)');
    expect(headers['X-App']).toBe('cli');
    expect(headers['Anthropic-Dangerous-Direct-Browser-Access']).toBe('true');
    expect(JSON.stringify(headers)).not.toMatch(/claude-code-proxy/);
  });

  it('carries the Stainless fingerprint, reporting the real runtime and host', () => {
    const headers = new ClaudeRequest().getHeaders('Bearer token');

    expect(headers['X-Stainless-Lang']).toBe('js');
    expect(headers['X-Stainless-Runtime']).toBe('node');
    expect(headers['X-Stainless-Runtime-Version']).toBe(process.version);
    expect(headers['X-Stainless-Retry-Count']).toBe('0');
    expect(headers['X-Stainless-Os']).toBe({
      darwin: 'MacOS', win32: 'Windows', linux: 'Linux', freebsd: 'FreeBSD'
    }[os.platform()] || `Other::${os.platform()}`);
    expect(headers['X-Stainless-Arch']).toBe({
      x64: 'x64', arm64: 'arm64', ia32: 'x86'
    }[os.arch()] || `other::${os.arch()}`);
  });

  it('sets the streaming helper header only on a streaming request', () => {
    expect(new ClaudeRequest().getHeaders('Bearer token', { stream: true })['X-Stainless-Helper-Method'])
      .toBe('stream');
    expect(new ClaudeRequest().getHeaders('Bearer token')['X-Stainless-Helper-Method'])
      .toBeUndefined();
  });

  it('advertises the beta flags the current CLI sends', () => {
    const beta = new ClaudeRequest().getHeaders('Bearer token')['anthropic-beta'].split(',');

    expect(beta).toContain('claude-code-20250219');
    expect(beta).toContain('oauth-2025-04-20');
    expect(beta).toContain('token-efficient-tools-2026-03-28');
    // Dropped by the CLI long ago; sending it would date the client.
    expect(beta).not.toContain('fine-grained-tool-streaming-2025-05-14');
  });

  it('does not ask upstream to redact thinking unless configured to', () => {
    // The flag makes upstream return thinking blocks with a signature and an
    // empty body, so it is the one CLI flag that is off by default.
    const beta = new ClaudeRequest().getHeaders('Bearer token')['anthropic-beta'].split(',');

    expect(beta).not.toContain('redact-thinking-2026-02-12');
  });

  it('restores the flag in the CLI\'s own position when enabled', () => {
    const on = ClaudeRequest.betaFlags(true);
    const off = ClaudeRequest.betaFlags(false);

    expect(on).toContain('redact-thinking-2026-02-12');
    expect(on.indexOf('redact-thinking-2026-02-12'))
      .toBe(on.indexOf('token-efficient-tools-2026-03-28') - 1);
    expect(on.filter(flag => flag !== 'redact-thinking-2026-02-12')).toEqual(off);
  });

  it('accepts compression instead of asking upstream for identity', () => {
    expect(new ClaudeRequest().getHeaders('Bearer token')['Accept-Encoding'])
      .toBe('gzip, deflate, br');
  });

  it('sends the beta query parameter the CLI uses', async () => {
    const scope = nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(200, { ok: true });

    await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(scope.isDone()).toBe(true);
  });

  it('adds the thinking-binding beta only when the body carries block_binding', async () => {
    const sentBetas = [];
    const thinking = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };

    for (const body of [{ thinking }, {}]) {
      nock('https://api.anthropic.com')
        .post('/v1/messages')
        .query({ beta: 'true' })
        .reply(function () {
          sentBetas.push(this.req.headers['anthropic-beta'].split(','));
          return [200, { ok: true }];
        });

      await request(messagesServer())
        .post('/v1/messages')
        .send({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }], ...body });
    }

    expect(sentBetas[0]).toEqual([...ClaudeRequest.betaFlags(), 'thinking-binding-controls-2026-08-01']);
    expect(sentBetas[1]).toEqual(ClaudeRequest.betaFlags());
  });
});

describe('CLI request fingerprint', () => {
  const OAT = 'sk-ant-oat01-TEST-TOKEN';

  it('carries the billing block and a derived user_id on a subscription token', () => {
    const processed = new ClaudeRequest().processRequestBody({
      model: SONNET,
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }]
    }, null, `Bearer ${OAT}`);

    expect(processed.system[0].text).toMatch(/^x-anthropic-billing-header:/);
    expect(processed.system[1].text).toMatch(/^You are Claude Code/);
    expect(processed.system[2].text).toBe('be terse');
    expect(JSON.parse(processed.metadata.user_id)).toHaveProperty('device_id');
  });

  it('adds nothing when the request is not on a subscription token', () => {
    const processed = new ClaudeRequest().processRequestBody({
      model: SONNET,
      messages: [{ role: 'user', content: 'hi' }]
    }, null, 'Bearer sk-ant-api03-KEY');

    expect(processed.system[0].text).toMatch(/^You are Claude Code/);
    expect(processed.metadata).toBeUndefined();
  });

  it('sends a byte-identical prefix on every turn so the cache is not thrown away', async () => {
    OAuthManager.getValidAccessToken.mockResolvedValue(OAT);
    const sentBodies = [];
    const capture = (body) => { sentBodies.push(body); return true; };

    for (const turn of ['first', 'second']) {
      nock('https://api.anthropic.com')
        .post('/v1/messages', capture)
        .query({ beta: 'true' })
        .reply(200, { ok: true });

      await request(messagesServer())
        .post('/v1/messages')
        .send({
          model: SONNET,
          system: 'be terse',
          messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: turn }]
        });
    }

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[1].system).toEqual(sentBodies[0].system);
    expect(sentBodies[1].metadata).toEqual(sentBodies[0].metadata);
  });

  it('keeps the same body across the 401 retry', async () => {
    OAuthManager.getValidAccessToken.mockResolvedValue(OAT);
    OAuthManager.refreshAccessToken.mockResolvedValue({ access_token: OAT });
    const sentBodies = [];
    const capture = (body) => { sentBodies.push(body); return true; };

    nock('https://api.anthropic.com').post('/v1/messages', capture).query({ beta: 'true' }).reply(401, {});
    nock('https://api.anthropic.com').post('/v1/messages', capture).query({ beta: 'true' }).reply(200, { ok: true });

    await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(sentBodies[1]).toEqual(sentBodies[0]);
    expect(sentBodies[0].system.filter(s => s.text.startsWith('x-anthropic-billing-header:'))).toHaveLength(1);
  });
});

describe('tool cloaking end to end', () => {
  const OAT = 'sk-ant-oat01-TEST-TOKEN';
  const clientTools = [{ name: 'search_web', description: 'search', input_schema: { type: 'object' } }];

  const sendWithTools = (extra = {}) => request(messagesServer())
    .post('/v1/messages')
    .send({ model: SONNET, tools: clientTools, messages: [{ role: 'user', content: 'hi' }], ...extra });

  beforeEach(() => {
    OAuthManager.getValidAccessToken.mockResolvedValue(OAT);
  });

  it('sends renamed client tools and the Claude Code set upstream', async () => {
    let sent;
    nock('https://api.anthropic.com')
      .post('/v1/messages', (body) => { sent = body; return true; })
      .query({ beta: 'true' })
      .reply(200, { id: 'msg_1', content: [] });

    await sendWithTools();

    const names = sent.tools.map(t => t.name);
    expect(names[0]).toBe('search_web_ide');
    expect(names).toContain('Bash');
    expect(names).toContain('WebSearch');
    expect(names).not.toContain('search_web');
  });

  it('leaves the tools alone when the request is not on a subscription token', async () => {
    OAuthManager.getValidAccessToken.mockResolvedValue('plain-token');
    let sent;
    nock('https://api.anthropic.com')
      .post('/v1/messages', (body) => { sent = body; return true; })
      .query({ beta: 'true' })
      .reply(200, { id: 'msg_1', content: [] });

    await sendWithTools();

    expect(sent.tools).toEqual(clientTools);
  });

  it('gives the client its own tool name back in a non-streaming response', async () => {
    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(200, JSON.stringify({
        id: 'msg_1',
        content: [
          { type: 'text', text: 'looking that up' },
          { type: 'tool_use', id: 'tu_1', name: 'search_web_ide', input: { q: 'x' } }
        ]
      }), { 'content-type': 'application/json' });

    const response = await sendWithTools();

    expect(response.body.content[1].name).toBe('search_web');
  });

  it('gives the client its own tool name back in a streamed response', async () => {
    const sse = 'event: content_block_start\n'
      + 'data: {"type":"content_block_start","index":0,"content_block":'
      + '{"type":"tool_use","id":"tu_1","name":"search_web_ide","input":{}}}\n\n'
      + 'event: content_block_delta\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n';

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(200, sse, { 'content-type': 'text/event-stream' });

    const response = await sendWithTools({ stream: true });

    expect(response.text).toContain('"name":"search_web"');
    expect(response.text).not.toContain('search_web_ide');
    // Everything that is not a tool name is forwarded untouched.
    expect(response.text).toContain('"partial_json":"{}"');
  });

  it('does not touch a response for a request that carried no tools', async () => {
    const sse = 'event: content_block_start\n'
      + 'data: {"type":"content_block_start","index":0,"content_block":'
      + '{"type":"tool_use","id":"tu_1","name":"search_web_ide","input":{}}}\n\n';

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(200, sse, { 'content-type': 'text/event-stream' });

    const response = await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, stream: true, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.text).toBe(sse);
  });
});

describe('compressed upstream responses', () => {
  it('decompresses a gzipped non-streaming body before framing it', async () => {
    const payload = JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'hi' }] });

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(200, zlib.gzipSync(payload), {
        'content-type': 'application/json',
        'content-encoding': 'gzip'
      });

    const response = await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    expect(response.body.content[0].text).toBe('hi');
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(Number(response.headers['content-length'])).toBe(Buffer.byteLength(response.text));
  });

  it('decompresses a gzipped event stream', async () => {
    const sse = 'event: content_block_delta\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n';

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(200, zlib.gzipSync(sse), {
        'content-type': 'text/event-stream',
        'content-encoding': 'gzip'
      });

    const response = await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, stream: true, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    expect(response.text).toBe(sse);
  });

  it('decompresses a deflated body', async () => {
    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(200, zlib.deflateSync(JSON.stringify({ id: 'msg_2' })), {
        'content-type': 'application/json',
        'content-encoding': 'deflate'
      });

    const response = await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.body.id).toBe('msg_2');
  });

  it('answers 502 instead of forwarding garbage when the compressed body is corrupt', async () => {
    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query({ beta: 'true' })
      .reply(200, Buffer.from('not actually gzip'), {
        'content-type': 'application/json',
        'content-encoding': 'gzip'
      });

    const response = await request(messagesServer())
      .post('/v1/messages')
      .send({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(502);
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

describe('cache usage tap', () => {
  const chatBody = { model: SONNET, messages: [{ role: 'user', content: 'hi' }] };

  const tap = async (chunks) => {
    const observe = jest.spyOn(CacheWatch, 'observe').mockReturnValue(null);
    const stream = new PassThrough();
    new ClaudeRequest().watchUsage(stream, chatBody);

    const finished = new Promise(resolve => stream.on('end', resolve));
    for (const chunk of chunks) stream.write(Buffer.from(chunk));
    stream.end();
    await finished;

    return observe;
  };

  it('finds usage when the body is split mid-line and mid-character', async () => {
    const sse = 'event: message_start\r\n'
      + 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,'
      + '"cache_read_input_tokens":0,"cache_creation_input_tokens":900,"output_tokens":1}}}\r\n\r\n'
      + 'event: content_block_delta\r\n'
      + 'data: {"type":"content_block_delta","delta":{"text":"héllo 👋"}}\r\n\r\n';

    // Seven bytes at a time cuts through UTF-8 sequences and JSON lines alike.
    const bytes = Buffer.from(sse, 'utf8');
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 7) {
      chunks.push(bytes.subarray(offset, offset + 7));
    }

    const observe = await tap(chunks);

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0].usage).toEqual({
      input_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 900,
      output_tokens: 1
    });
    expect(observe.mock.calls[0][0].body).toBe(chatBody);
  });

  it('reports only the first usage event of a stream', async () => {
    const sse = 'event: message_start\n'
      + 'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":0,"cache_creation_input_tokens":900}}}\n\n'
      + 'event: message_delta\n'
      + 'data: {"type":"message_delta","usage":{"cache_read_input_tokens":0,"output_tokens":12}}\n\n';

    const observe = await tap([sse]);

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0].usage.output_tokens).toBeUndefined();
  });

  it('keeps looking past events that carry no cache accounting', async () => {
    const sse = 'event: message_start\n'
      + 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n'
      + 'data: not json at all\n\n'
      + 'event: message_delta\n'
      + 'data: {"type":"message_delta","usage":{"cache_read_input_tokens":0,"output_tokens":12}}\n\n';

    const observe = await tap([sse]);

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0].usage.cache_read_input_tokens).toBe(0);
  });
});
