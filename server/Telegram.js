const fs = require('fs');
const https = require('https');
const path = require('path');
const Logger = require('./Logger');

// A hung Telegram API would otherwise hold the socket open until the process
// exits; the notification is best effort and can be dropped.
const TIMEOUT_MS = 10 * 1000;

// Built on first use: an optional feature must not fail process start on a
// Node without full ICU, where constructing this throws.
let jakartaFormatter = null;

const formatter = () => {
  if (!jakartaFormatter) {
    jakartaFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }
  return jakartaFormatter;
};

/**
 * A chat id may name a forum topic: the Telegram app shows that chat as
 * "-1001234567890:534". The Bot API wants the two as separate fields, so the
 * suffix becomes message_thread_id and the bare id stays chat_id.
 */
const splitChatId = (value) => {
  const [chatId, threadId] = String(value || '').split(':');
  return {
    chat_id: chatId,
    message_thread_id: /^\d+$/.test(threadId) ? Number(threadId) : null
  };
};

/**
 * One-way Telegram notifications. Settings live beside the account store, so a
 * Docker volume that survives a restart keeps them, and the file is re-read on
 * every send so a save from the web UI applies without a restart.
 */
class Telegram {
  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE;
    this.settingsPath = path.join(home, '.claude-code-proxy', 'telegram.json');
  }

  /**
   * @returns {{bot_token: string, chat_id: string}} empty strings when unset
   */
  loadSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      return {
        bot_token: typeof parsed?.bot_token === 'string' ? parsed.bot_token.trim() : '',
        chat_id: typeof parsed?.chat_id === 'string' ? parsed.chat_id.trim() : ''
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        Logger.warn(`Failed to read Telegram settings: ${error.message}`);
      }
      return { bot_token: '', chat_id: '' };
    }
  }

  /**
   * An empty bot_token keeps the stored one, so the UI can leave the field
   * blank; chat_id is always replaced, and an empty one disables notifications.
   * @param {{bot_token?: string, chat_id?: string}} settings
   * @returns {{bot_token: string, chat_id: string}} the stored pair
   */
  saveSettings({ bot_token, chat_id } = {}) {
    const current = this.loadSettings();
    const merged = {
      bot_token: (typeof bot_token === 'string' && bot_token.trim()) || current.bot_token,
      chat_id: typeof chat_id === 'string' ? chat_id.trim() : ''
    };

    const dir = path.dirname(this.settingsPath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${this.settingsPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      fs.chmodSync(tmpPath, 0o600);
    }
    fs.renameSync(tmpPath, this.settingsPath);

    return merged;
  }

  /**
   * What the browser is allowed to see: never the token itself.
   */
  publicSettings() {
    const { bot_token, chat_id } = this.loadSettings();
    return {
      chat_id,
      bot_token_set: Boolean(bot_token),
      configured: Boolean(bot_token && splitChatId(chat_id).chat_id)
    };
  }

  /**
   * Fire-and-forget delivery: resolves false instead of throwing, so a
   * notification problem can never reach a proxy response.
   * @param {string} text
   * @returns {Promise<boolean>} true when Telegram accepted the message
   */
  send(text) {
    const { bot_token, chat_id: target } = this.loadSettings();
    const { chat_id, message_thread_id } = splitChatId(target);
    if (!bot_token || !chat_id) return Promise.resolve(false);

    return new Promise(resolve => {
      const payload = JSON.stringify({
        chat_id,
        text,
        disable_web_page_preview: true,
        ...(message_thread_id === null ? {} : { message_thread_id })
      });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      let req;
      try {
        req = https.request({
          hostname: 'api.telegram.org',
          port: 443,
          // Never logged: the bot token sits in the path.
          path: `/bot${bot_token}/sendMessage`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, (response) => {
          let body = '';
          response.on('data', chunk => { body += chunk; });
          response.on('end', () => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
              // The token is never part of this line: only where the message went.
              Logger.info(
                `Telegram notification sent (chat ${chat_id}`
                + `${message_thread_id === null ? '' : `, topic ${message_thread_id}`})`
              );
              finish(true);
              return;
            }
            Logger.warn(`Telegram send failed with HTTP ${response.statusCode}: ${body.slice(0, 200)}`);
            finish(false);
          });
          response.on('error', (error) => {
            Logger.warn(`Telegram response error: ${error.message}`);
            finish(false);
          });
        });
      } catch (error) {
        Logger.warn(`Telegram send failed: ${error.message}`);
        finish(false);
        return;
      }

      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('Telegram request timed out')));
      req.on('error', (error) => {
        Logger.warn(`Telegram send failed: ${error.message}`);
        finish(false);
      });
      req.end(payload);
    });
  }

  /**
   * @param {number|null} atMs
   * @returns {string} e.g. "22 Nov 2026, 10:00:00 WIB", or "not scheduled"
   */
  formatJakarta(atMs) {
    // null is "no next ping", not the epoch.
    if (atMs === null || atMs === undefined) return 'not scheduled';

    const ms = Number(atMs);
    if (!Number.isFinite(ms)) return 'not scheduled';

    try {
      return `${formatter().format(new Date(ms))} WIB`;
    } catch (error) {
      return new Date(ms).toISOString();
    }
  }
}

module.exports = new Telegram();
