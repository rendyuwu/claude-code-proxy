const Telegram = require('./Telegram');
const CacheWatch = require('./CacheWatch');

const MODEL = 'claude-sonnet-5';

const body = (over = {}) => ({
  model: MODEL,
  system: 'be terse',
  messages: [{ role: 'user', content: 'hi' }],
  ...over
});

const usage = (over = {}) => ({
  input_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 1000,
  output_tokens: 5,
  ...over
});

const texts = () => Telegram.send.mock.calls.map(([text]) => text);

beforeEach(() => {
  CacheWatch.reset();
  jest.spyOn(Telegram, 'send').mockResolvedValue(true);
  jest.spyOn(Telegram, 'isModelSilenced').mockReturnValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('CacheWatch.observe', () => {
  it('labels the first zero read of a chat new and reports it', () => {
    const info = CacheWatch.observe({ body: body(), usage: usage() });

    expect(info).toMatchObject({
      kind: 'new',
      requestNumber: 1,
      previousCacheRead: null,
      prefixChanged: false
    });

    const [text] = texts();
    expect(texts()).toHaveLength(1);
    expect(text).toContain('Cache read 0: new chat');
    expect(text).toContain(`Model: ${MODEL}`);
    expect(text).toContain('Request: #1');
    expect(text).toContain('Tokens: input=10, cache_read=0, cache_write=1000, output=5');
    expect(text).toMatch(/Time: .* WIB/);
  });

  it('stays quiet on a cache hit, then calls the next zero read a break', () => {
    CacheWatch.observe({ body: body(), usage: usage() });

    const hit = CacheWatch.observe({ body: body(), usage: usage({ cache_read_input_tokens: 40000 }) });
    expect(hit.kind).toBe('miss');
    expect(texts()).toHaveLength(1);

    const broke = CacheWatch.observe({ body: body(), usage: usage() });

    expect(broke.kind).toBe('break');
    expect(broke.previousCacheRead).toBe(40000);
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain('Cache read 0: CACHE BREAK');
    expect(texts()[1]).toContain('Previous cache_read: 40000');
  });

  it('calls a changed prompt prefix a break even with no earlier hit', () => {
    const headers = { 'x-chat-id': 'chat-1' };
    // A zero read first: the break below has to come from the prefix, not from
    // a remembered hit.
    CacheWatch.observe({ headers, body: body(), usage: usage() });

    const changed = CacheWatch.observe({ headers, body: body({ system: 'be verbose' }), usage: usage() });

    expect(changed.kind).toBe('break');
    expect(changed.prefixChanged).toBe(true);
    expect(changed.previousCacheRead).toBe(0);
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain('Cause: prompt prefix changed (model/system/first message)');
  });

  it('calls a zero read with no hit yet a miss, not a break', () => {
    CacheWatch.observe({ body: body(), usage: usage() });
    const again = CacheWatch.observe({ body: body(), usage: usage() });

    expect(again.kind).toBe('miss');
    expect(texts()[1]).toContain('Cache read 0: no cache hit yet');
  });

  it('prefers a client chat id header over the seeded opening message', () => {
    const info = CacheWatch.observe({
      headers: { 'x-chat-id': 'chat-9' },
      body: body(),
      usage: usage()
    });

    expect(info.chatId).toBe('chat-9');
    expect(CacheWatch.entries.has('chat-9')).toBe(true);
  });

  it('reads metadata.user_id as a conversation id in both shapes', () => {
    const asObject = CacheWatch.observe({
      body: body({ metadata: { user_id: { session_id: 'session-1' } } }),
      usage: usage()
    });
    expect(asObject.chatId).toBe('session-1');

    const asJson = CacheWatch.observe({
      body: body({ metadata: { user_id: JSON.stringify({ session_id: 'session-2' }) } }),
      usage: usage()
    });
    expect(asJson.chatId).toBe('session-2');
  });

  it('keeps one chat id while the conversation grows', () => {
    const first = CacheWatch.observe({ body: body(), usage: usage() });
    const second = CacheWatch.observe({
      body: body({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' }
        ]
      }),
      usage: usage({ cache_read_input_tokens: 1200 })
    });

    expect(first.chatId).toMatch(/^seed:/);
    expect(second.chatId).toBe(first.chatId);
    expect(second.requestNumber).toBe(2);
    // The second turn was a hit, so only the opening one was reported.
    expect(texts()).toHaveLength(1);
  });

  it('shows an unknown output count rather than inventing one', () => {
    CacheWatch.observe({ body: body(), usage: usage({ output_tokens: undefined }) });

    expect(texts()[0]).toContain('output=?');
  });

  it('ignores a response with no cache accounting at all', () => {
    expect(CacheWatch.observe({ body: body(), usage: { input_tokens: 10 } })).toBeNull();
    expect(CacheWatch.observe({ body: body(), usage: null })).toBeNull();
    expect(CacheWatch.observe({ usage: usage() })).toBeNull();

    expect(Telegram.send).not.toHaveBeenCalled();
    expect(CacheWatch.entries.size).toBe(0);
  });

  it('suppresses notifications for a silenced model while still tracking the chat', () => {
    Telegram.isModelSilenced.mockReturnValue(true);

    const first = CacheWatch.observe({
      body: body({ model: 'claude-haiku-5-5' }),
      usage: usage()
    });
    CacheWatch.observe({
      body: body({ model: 'claude-haiku-5-5' }),
      usage: usage({ cache_read_input_tokens: 40000 })
    });
    const broke = CacheWatch.observe({
      body: body({ model: 'claude-haiku-5-5' }),
      usage: usage()
    });

    expect(Telegram.send).not.toHaveBeenCalled();
    expect(first.kind).toBe('new');
    expect(broke.kind).toBe('break');
    expect(broke.requestNumber).toBe(3);
    expect(CacheWatch.entries.has(broke.chatId)).toBe(true);
  });

  it('evicts the least recently seen chat, not the busiest one', () => {
    const ids = [];
    for (let i = 0; i < 1000; i += 1) {
      ids.push(CacheWatch.observe({
        body: body({ messages: [{ role: 'user', content: `chat ${i}` }] }),
        usage: usage({ cache_read_input_tokens: 1000 })
      }).chatId);
    }

    // The first chat is used again, then one more chat overflows the map.
    const hot = CacheWatch.observe({
      body: body({ messages: [{ role: 'user', content: 'chat 0' }] }),
      usage: usage({ cache_read_input_tokens: 1000 })
    });
    CacheWatch.observe({
      body: body({ messages: [{ role: 'user', content: 'brand new chat' }] }),
      usage: usage({ cache_read_input_tokens: 1000 })
    });

    expect(hot.chatId).toBe(ids[0]);
    expect(CacheWatch.entries.size).toBe(1000);
    expect(CacheWatch.entries.has(ids[0])).toBe(true);
    expect(CacheWatch.entries.has(ids[1])).toBe(false);
  });
});
