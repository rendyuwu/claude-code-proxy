const Logger = require('./Logger');
const OAuthManager = require('./OAuthManager');
const ClaudeRequest = require('./ClaudeRequest');
const Telegram = require('./Telegram');

// A window reset is not a to-the-second event, so a 30s scan is cheap and
// well inside the 10s grace the candidate check already allows.
const CHECK_INTERVAL_MS = 30 * 1000;

// One failure backs that account off for minutes, not one check interval:
// a ping that failed on the network should not hammer every 30s.
const RETRY_INTERVAL_MS = 5 * 60 * 1000;

// A 4xx that is neither 401 nor 429 will not fix itself: an unknown model name
// or a revoked refresh token would otherwise retry every five minutes forever.
const PERMANENT_RETRY_INTERVAL_MS = 60 * 60 * 1000;

const MODEL = 'claude-haiku-4-5';
const MESSAGE = 'ping';

// Resolve without reading the body into memory: one token is enough to start
// the window, and the reply is not used.
function drainResponse(response) {
  return new Promise(resolve => {
    response.on('end', resolve);
    response.on('error', resolve);
    response.on('close', resolve);
    response.resume();
  });
}

/**
 * Starts each pooled account's next 5-hour window at its reset. Without this
 * an idle account's window never restarts, so its countdown never reappears
 * until real traffic arrives.
 */
const AutoPing = {
  timer: null,
  running: false,
  retries: new Map(), // account id -> earliest next attempt

  start() {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.tick().catch(error => Logger.warn(`Auto ping check failed: ${error.message}`));
    }, CHECK_INTERVAL_MS);
    // Scheduling work must never be the reason the process stays alive.
    this.timer.unref();

    this.tick().catch(error => Logger.warn(`Auto ping check failed: ${error.message}`));
  },

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.retries.clear();
  },

  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;

    try {
      for (const account of OAuthManager.getAutoPingCandidates(now)) {
        if (this.retries.get(account.id) > now) continue;

        let outcome;
        try {
          outcome = await this.ping(account);
        } catch (error) {
          Logger.warn(`Auto ping failed for ${account.label}: ${error.message}`);
          this.retries.set(account.id, Date.now() + (error.retryMs || RETRY_INTERVAL_MS));
          outcome = { ok: false, detail: error.message };
        }

        if (outcome.ok) this.retries.delete(account.id);
        this.announce(account, outcome);
      }
    } finally {
      this.running = false;
    }
  },

  /**
   * One message per ping attempt, fire and forget: the ping itself has already
   * been recorded and must not wait on Telegram.
   * @param {Object} account the candidate the tick worked on
   * @param {{ok: boolean, detail: string}} outcome
   */
  announce(account, outcome) {
    const stored = OAuthManager.loadState().accounts.find(a => a.id === account.id) || account;
    const nextAt = OAuthManager.nextAutoPingAt(account.id, {
      retryAt: this.retries.get(account.id) || null
    });

    const text = [
      `Auto-ping ${MODEL}: ${outcome.ok ? 'OK' : 'FAILED'}`,
      `Account: ${stored.label || stored.id}`,
      `Detail: ${outcome.detail}`,
      `Next ping: ${Telegram.formatJakarta(nextAt)}`
    ].join('\n');

    Telegram.send(text).catch(error =>
      Logger.warn(`Failed to send auto-ping notification: ${error.message}`));
  },

  async ping(account) {
    const body = {
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: MESSAGE }]
    };

    // makeRequest, not the local /v1/messages route: the explicit token below
    // bills the target account, while the route would select the active one.
    const request = new ClaudeRequest();

    const token = await OAuthManager.getValidAccessToken(account.id);
    let response = await request.makeRequest(body, null, `Bearer ${token}`);

    if (response.statusCode === 401) {
      await drainResponse(response);
      // Refreshing by id, never loadOrRefreshToken: that would re-select the
      // active account and ping somebody else.
      await OAuthManager.refreshAccessToken(account.id);
      const refreshed = await OAuthManager.getValidAccessToken(account.id);
      response = await request.makeRequest(body, null, `Bearer ${refreshed}`);
    }

    const status = response.statusCode;
    const headers = response.headers;
    await drainResponse(response);

    if (status === 429) {
      OAuthManager.markAccountLimited(account.id, {
        resetAtMs: ClaudeRequest.limitResetAtMs(headers),
        fiveHourResetAtMs: ClaudeRequest.fiveHourResetAtMs(headers),
        reason: 'rate_limit'
      });
      Logger.warn(`Auto ping hit a rate limit on ${account.label}`);
      return { ok: false, detail: 'HTTP 429 rate limit' };
    }

    if (status >= 200 && status < 300) {
      OAuthManager.recordAutoPingResult(account.id, ClaudeRequest.fiveHourResetAtMs(headers));
      Logger.info(`Auto ping started the next 5-hour window for ${account.label}`);
      return { ok: true, detail: `HTTP ${status}` };
    }

    const error = new Error(`auto ping got HTTP ${status}`);
    if (status >= 400 && status < 500) error.retryMs = PERMANENT_RETRY_INTERVAL_MS;
    throw error;
  }
};

module.exports = AutoPing;
