// Route-level tests that drive the real handleRequest from server.js, rather
// than a copy of its logic.
const http = require('http');
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
  getTokenExpiration: jest.fn().mockReturnValue(new Date(Date.now() + 3600000)),
  generatePKCE: jest.fn(),
  buildAuthorizationURL: jest.fn(),
  exchangeCodeForTokens: jest.fn(),
  saveTokens: jest.fn(),
  logout: jest.fn()
}));

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
