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

const Logger = require('./Logger');
const Telegram = require('./Telegram');

const TEST_DIR = path.join(__dirname, '.test-telegram');
const SETTINGS_PATH = path.join(TEST_DIR, 'telegram.json');

const configure = (settings = { bot_token: '123:abc', chat_id: '-100123' }) =>
  Telegram.saveSettings(settings);

beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
  Telegram.settingsPath = SETTINGS_PATH;
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  nock.cleanAll();
  nock.enableNetConnect();
});

describe('settings', () => {
  it('reports nothing configured before the first save', () => {
    expect(Telegram.loadSettings()).toEqual({ bot_token: '', chat_id: '' });
    expect(Telegram.publicSettings()).toEqual({
      chat_id: '',
      bot_token_set: false,
      configured: false
    });
  });

  it('trims both values and never returns the token publicly', () => {
    configure({ bot_token: '  123:abc  ', chat_id: '  -100123  ' });

    expect(Telegram.loadSettings()).toEqual({ bot_token: '123:abc', chat_id: '-100123' });
    expect(Telegram.publicSettings()).toEqual({
      chat_id: '-100123',
      bot_token_set: true,
      configured: true
    });
    expect(JSON.stringify(Telegram.publicSettings())).not.toContain('123:abc');
  });

  it('keeps the stored token when the next save leaves it blank', () => {
    configure();

    const merged = Telegram.saveSettings({ chat_id: '-100456' });

    expect(merged).toEqual({ bot_token: '123:abc', chat_id: '-100456' });
    expect(Telegram.loadSettings().bot_token).toBe('123:abc');
  });

  it('clears the chat id but not the token when the chat id is emptied', () => {
    configure();

    expect(Telegram.saveSettings({ chat_id: '' })).toEqual({ bot_token: '123:abc', chat_id: '' });
    expect(Telegram.publicSettings().configured).toBe(false);
  });

  it('writes the settings file at mode 0600', () => {
    configure();

    const stats = fs.statSync(SETTINGS_PATH);

    expect(JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')))
      .toEqual({ bot_token: '123:abc', chat_id: '-100123' });
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('falls back to empty settings on an unreadable file', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, '{broken', 'utf8');

    expect(Telegram.loadSettings()).toEqual({ bot_token: '', chat_id: '' });
    expect(Logger.warn).toHaveBeenCalled();
  });
});

describe('send', () => {
  it('posts the message to the bot endpoint without touching the URL in logs', async () => {
    configure();

    const scope = nock('https://api.telegram.org')
      .post('/bot123:abc/sendMessage', body => (
        body.chat_id === '-100123'
        && body.text === 'hello'
        && body.disable_web_page_preview === true
        && body.message_thread_id === undefined
      ))
      .reply(200, { ok: true });

    await expect(Telegram.send('hello')).resolves.toBe(true);
    expect(scope.isDone()).toBe(true);
    expect(Logger.info).toHaveBeenCalledWith('Telegram notification sent (chat -100123)');
  });

  it('posts the forum topic id when the chat id names one', async () => {
    configure({ bot_token: '123:abc', chat_id: '-100123:534' });

    const scope = nock('https://api.telegram.org')
      .post('/bot123:abc/sendMessage', body => (
        body.chat_id === '-100123'
        && body.message_thread_id === 534
        && body.text === 'hello'
      ))
      .reply(200, { ok: true });

    await expect(Telegram.send('hello')).resolves.toBe(true);
    expect(scope.isDone()).toBe(true);
    expect(Logger.info).toHaveBeenCalledWith('Telegram notification sent (chat -100123, topic 534)');
  });

  it('resolves false on an HTTP error instead of throwing', async () => {
    configure();

    nock('https://api.telegram.org')
      .post('/bot123:abc/sendMessage')
      .reply(400, { ok: false, description: 'chat not found' });

    await expect(Telegram.send('hello')).resolves.toBe(false);
    expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 400'));
  });

  it('resolves false on a network error', async () => {
    configure();

    nock('https://api.telegram.org')
      .post('/bot123:abc/sendMessage')
      .replyWithError('socket hang up');

    await expect(Telegram.send('hello')).resolves.toBe(false);
  });

  it('does not call Telegram at all when unconfigured', async () => {
    const scope = nock('https://api.telegram.org')
      .post('/bot1:x/sendMessage')
      .reply(200, { ok: true });

    await expect(Telegram.send('hello')).resolves.toBe(false);
    expect(scope.isDone()).toBe(false);
  });

  it('does not call Telegram when only the chat id is set', async () => {
    configure({ bot_token: '', chat_id: '-100123' });

    const scope = nock('https://api.telegram.org').post(/.*/).reply(200, { ok: true });

    await expect(Telegram.send('hello')).resolves.toBe(false);
    expect(scope.isDone()).toBe(false);
  });
});

describe('formatJakarta', () => {
  it('renders a timestamp in Asia/Jakarta with an explicit WIB suffix', () => {
    expect(Telegram.formatJakarta(Date.UTC(2026, 10, 22, 3, 0, 0)))
      .toBe('22 Nov 2026, 10:00:00 WIB');
  });

  it('says so when there is no next ping', () => {
    expect(Telegram.formatJakarta(null)).toBe('not scheduled');
    expect(Telegram.formatJakarta(undefined)).toBe('not scheduled');
    expect(Telegram.formatJakarta(NaN)).toBe('not scheduled');
  });
});
