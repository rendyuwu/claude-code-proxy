const crypto = require('crypto');
const Logger = require('./Logger');
const Telegram = require('./Telegram');
const { conversationSeed } = require('./cloaking');

// A chat that has not been seen for a day is over as far as cache diagnostics
// go; keeping it forever would only make an old break look current.
const TRACK_TTL_MS = 24 * 60 * 60 * 1000;

// The map is per process and small; this is the ceiling that keeps a client
// inventing a new chat id per request from growing it without bound.
const MAX_TRACKED_CHATS = 1000;

const MAX_ID_LENGTH = 64;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const finiteNumber = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const headerId = (headers, name) => {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  return (value.trim().slice(0, MAX_ID_LENGTH) || null);
};

// metadata.user_id is stamped by the proxy itself as JSON, but a client may
// send one too; either shape is acceptable as long as it names a session.
const sessionId = (body) => {
  let userId = body?.metadata?.user_id;
  if (typeof userId === 'string') {
    try {
      userId = JSON.parse(userId);
    } catch (error) {
      return null;
    }
  }
  const value = userId?.session_id;
  if (typeof value !== 'string') return null;
  return (value.trim().slice(0, MAX_ID_LENGTH) || null);
};

/**
 * Who the conversation belongs to. No front end in use sends a chat id, so the
 * opening message is hashed: it is the one part of a growing conversation that
 * does not change between turns. Headers and metadata win when a client does
 * supply them.
 */
const chatIdFor = (headers, body) => {
  const explicit = headerId(headers, 'x-chat-id')
    || headerId(headers, 'x-conversation-id')
    || headerId(headers, 'x-session-id')
    || sessionId(body);
  if (explicit) return explicit;

  const first = Array.isArray(body?.messages) ? body.messages[0] : null;
  const seedSource = first !== undefined && first !== null
    ? JSON.stringify(first)
    : conversationSeed(body);
  return `seed:${sha256(seedSource).slice(0, 12)}`;
};

const labelFor = (kind) => {
  if (kind === 'break') return 'CACHE BREAK';
  if (kind === 'miss') return 'no cache hit yet';
  return 'new chat';
};

const describe = ({ kind, chatId, model, requestNumber, input, cacheWrite, output, previousCacheRead, prefixChanged, at }) => {
  const lines = [
    `Cache read 0: ${labelFor(kind)}`,
    `Chat: ${chatId}`,
    `Model: ${model}`,
    `Request: #${requestNumber}`,
    `Tokens: input=${input}, cache_read=0, cache_write=${cacheWrite}, output=${output === null ? '?' : output}`
  ];
  if (kind === 'break' && previousCacheRead > 0) {
    lines.push(`Previous cache_read: ${previousCacheRead}`);
  }
  if (prefixChanged) {
    lines.push('Cause: prompt prefix changed (model/system/first message)');
  }
  lines.push(`Time: ${Telegram.formatJakarta(at)}`);
  return lines.join('\n');
};

/**
 * Classifies a successful response's cache usage per conversation and reports
 * a zero read. In memory only: a restart forgets which chats were warm, so the
 * next zero read is labelled new rather than a break.
 */
const CacheWatch = {
  entries: new Map(), // chat id -> { requests, lastCacheRead, prefixKey, lastSeenAt }

  /**
   * @param {{headers?: Object, body?: Object|null, usage?: Object|null, at?: number}} input
   * @returns {{kind: string, chatId: string, requestNumber: number,
   *   previousCacheRead: number|null, prefixChanged: boolean}|null}
   */
  observe({ headers = {}, body = null, usage = null, at = Date.now() } = {}) {
    try {
      if (!usage || typeof usage !== 'object') return null;
      // An upstream that does not report cache usage at all must not look like
      // a cache miss.
      if (!('cache_read_input_tokens' in usage)
        && !('cache_creation_input_tokens' in usage)) return null;
      if (!body) return null;

      const cacheRead = finiteNumber(usage.cache_read_input_tokens, 0);
      const cacheWrite = finiteNumber(usage.cache_creation_input_tokens, 0);
      const input = finiteNumber(usage.input_tokens, 0);
      const output = Number.isFinite(Number(usage.output_tokens))
        ? Number(usage.output_tokens)
        : null;
      const model = typeof body.model === 'string' ? body.model : 'unknown';

      const chatId = chatIdFor(headers, body);
      // A different model, system prompt or opening message is a different
      // cached prefix, whether or not it is the same chat.
      const prefixKey = sha256(conversationSeed(body));

      const previous = this.entries.get(chatId);
      let kind = 'new';
      if (previous) {
        kind = previous.lastCacheRead > 0 || previous.prefixKey !== prefixKey ? 'break' : 'miss';
      }

      const requestNumber = (previous?.requests || 0) + 1;
      const previousCacheRead = previous?.lastCacheRead ?? null;
      const prefixChanged = Boolean(previous && previous.prefixKey !== prefixKey);

      // Deleted and re-inserted, not just overwritten: Map.set on an existing
      // key keeps its original position, so pruning would drop the busiest
      // chats first, right after updating them.
      this.entries.delete(chatId);
      this.entries.set(chatId, {
        requests: requestNumber,
        lastCacheRead: cacheRead,
        prefixKey,
        lastSeenAt: at
      });
      this.prune(at);

      if (cacheRead === 0 && !Telegram.isModelSilenced(model)) {
        const text = describe({
          kind, chatId, model, requestNumber, input, cacheWrite, output,
          previousCacheRead, prefixChanged, at
        });
        Telegram.send(text).catch(error =>
          Logger.warn(`Failed to send cache notification: ${error.message}`));
      }

      return { kind, chatId, requestNumber, previousCacheRead, prefixChanged };
    } catch (error) {
      // Diagnostics must never break the response path.
      Logger.warn(`Cache watch failed: ${error.message}`);
      return null;
    }
  },

  prune(at = Date.now()) {
    for (const [chatId, entry] of this.entries) {
      if (at - entry.lastSeenAt > TRACK_TTL_MS) this.entries.delete(chatId);
    }
    // Least recently seen first: an entry is re-inserted on every update, so
    // Map order is last-seen order.
    for (const chatId of this.entries.keys()) {
      if (this.entries.size <= MAX_TRACKED_CHATS) break;
      this.entries.delete(chatId);
    }
  },

  reset() {
    this.entries.clear();
  }
};

module.exports = CacheWatch;
