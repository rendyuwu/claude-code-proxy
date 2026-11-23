'use strict';

const Logger = require('./Logger');
const OAuthManager = require('./OAuthManager');
const Telegram = require('./Telegram');
const Usage = require('./Usage');
const Cron = require('./Cron');
const wib = require('./wib');

// The reference script caches its usage response for five minutes; the same
// cadence here means a window that crosses the threshold is noticed quickly
// without hammering the endpoint.
const ALERT_INTERVAL_MS = 5 * 60 * 1000;

// Notifications are a side channel; a burst of them must not block the timer.
// One shared lock keeps a slow upstream from queueing a second round.
const REPORT_TICK_MS = 30 * 1000;

// The upstream reports resets_at with sub-second precision, and a value that
// moves by a few seconds between polls is still the same window. Comparing the
// timestamps exactly made every poll alert again; this tolerance is far below
// the shortest real window (5 hours), so a new window is still recognised.
const RESET_TOLERANCE_MS = 5 * 60 * 1000;

// A fallback alert suppression when the upstream gave no reset time: long
// enough not to repeat every poll, short enough to warn again if the window
// keeps running down.
const NO_RESET_REALERT_MS = 6 * 60 * 60 * 1000;

/**
 * Per-account subscription watcher.
 *
 * Two things are sent to the configured Telegram chat:
 *  - a low-limit alert the first time a 5-hour or 7-day window drops to the
 *    last 10% (once per window: the reset time is the window's identity);
 *  - the limit.sh-style usage report on a cron schedule set in the web UI.
 *
 * Both label every block with the account it belongs to, because the whole
 * point is knowing which account is about to run out.
 */
const LimitWatch = {
  alertTimer: null,
  reportTimer: null,
  firstPollTimer: null,
  polling: false,
  reporting: false,
  alerted: new Map(), // account id -> Map(limit key -> { resetAt, at })
  cronExpression: null,
  nextRunAt: null,

  /**
   * @param {{alertIntervalMs?: number, reportTickMs?: number}} options
   *   the intervals are overridable so tests do not wait on the clock
   */
  start({ alertIntervalMs = ALERT_INTERVAL_MS, reportTickMs = REPORT_TICK_MS } = {}) {
    if (this.alertTimer || this.reportTimer) return;

    this.alertTimer = setInterval(() => {
      this.pollLowLimits().catch(error =>
        Logger.warn(`Limit alert check failed: ${error.message}`));
    }, alertIntervalMs);
    this.alertTimer.unref();

    this.reportTimer = setInterval(() => {
      this.tickReports().catch(error =>
        Logger.warn(`Limit report check failed: ${error.message}`));
    }, reportTickMs);
    this.reportTimer.unref();

    // A short delay keeps the first usage fetch off the startup path, where a
    // slow network would delay the listening-server log line.
    this.firstPollTimer = setTimeout(() => {
      this.pollLowLimits().catch(error =>
        Logger.warn(`Limit alert check failed: ${error.message}`));
    }, 15 * 1000);
    this.firstPollTimer.unref();
  },

  stop() {
    if (this.firstPollTimer) {
      clearTimeout(this.firstPollTimer);
      this.firstPollTimer = null;
    }
    if (this.alertTimer) {
      clearInterval(this.alertTimer);
      this.alertTimer = null;
    }
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
    this.alerted.clear();
    this.cronExpression = null;
    this.nextRunAt = null;
  },

  /** Forget which windows were already announced (used by tests and logout). */
  reset() {
    this.alerted.clear();
    this.cronExpression = null;
    this.nextRunAt = null;
  },

  // Only accounts that can actually serve traffic are polled: a disabled one
  // is not going to run out, and its usage is history.
  eligibleAccounts() {
    const state = OAuthManager.loadState();
    return state.accounts.filter(account =>
      !account.disabled && account.access_token && account.refresh_token);
  },

  isActive(accountId) {
    return OAuthManager.loadState().active_account_id === accountId;
  },

  /**
   * Fetch one account's usage, returning null instead of throwing so one
   * broken account cannot stop the round.
   * @param {Object} account
   * @returns {Promise<Object|null>}
   */
  async usageFor(account) {
    try {
      return await Usage.getAccountUsage(account);
    } catch (error) {
      Logger.warn(`Usage lookup failed for ${account.label || account.id}: ${error.message}`);
      return null;
    }
  },

  /**
   * One alert per account and window: the reset time identifies the window, so
   * a new window re-arms the alert and the same window does not repeat.
   * @param {Object} account
   * @param {Object} limit
   * @param {number} now
   * @returns {boolean} true when this call should send
   */
  shouldAlert(account, limit, now) {
    const key = Usage.limitKey(limit);
    let forAccount = this.alerted.get(account.id);
    if (!forAccount) {
      forAccount = new Map();
      this.alerted.set(account.id, forAccount);
    }

    const previous = forAccount.get(key);
    if (previous) {
      // A window that had no reset time on the last poll and has one now is
      // still the same window, so a missing value on either side falls back to
      // the wall clock rather than looking like a brand new window.
      const comparable = limit.resetsAt && previous.resetAt;
      if (comparable) {
        if (Math.abs(previous.resetAt - limit.resetsAt) <= RESET_TOLERANCE_MS) return false;
      } else if (now - previous.at < NO_RESET_REALERT_MS) {
        return false;
      }
    }

    forAccount.set(key, { resetAt: limit.resetsAt || null, at: now });
    return true;
  },

  /**
   * Look for windows at or below the remaining threshold and announce each one
   * once. Never throws: this runs on a timer.
   * @param {{threshold?: number, now?: number, accounts?: Object[]}} options
   * @returns {Promise<Object[]>} the limits that were announced
   */
  async pollLowLimits({ threshold, now = Date.now(), accounts = null } = {}) {
    if (this.polling) return [];
    this.polling = true;

    const announced = [];
    try {
      const settings = Telegram.loadSettings();
      // No chat to send to means the upstream calls would be paid for nothing.
      if (!settings.limit_alerts_enabled) return [];
      if (!settings.bot_token || !settings.chat_id) return [];
      const remaining = Number.isFinite(Number(threshold))
        ? Number(threshold)
        : settings.limit_alert_threshold;

      const pool = accounts || this.eligibleAccounts();
      // An account that was deleted leaves its window keys behind, and a new
      // login gets a new id, so nothing would ever clear them.
      const known = new Set(OAuthManager.loadState().accounts.map(account => account.id));
      for (const accountId of this.alerted.keys()) {
        if (!known.has(accountId)) this.alerted.delete(accountId);
      }

      for (const account of pool) {
        const usage = await this.usageFor(account);
        if (!usage) continue;

        // One message per account per poll: if two windows are running out at
        // once, reading them together is what tells you the account is about
        // to be unusable rather than one window being low.
        const due = Usage.lowLimits(usage, remaining)
          .filter(limit => this.shouldAlert(account, limit, now));
        if (due.length === 0) continue;

        const text = Usage.formatLowLimitAlert(account, due, {
          active: this.isActive(account.id),
          now
        });
        const sent = await Telegram.send(text);
        if (sent) {
          for (const limit of due) announced.push({ accountId: account.id, limit });
          Logger.info(
            `Limit alert sent for ${account.label || account.id}: `
            + `${due.map(limit => `${Usage.limitTitle(limit)} at ${limit.percent}%`).join(', ')}`
          );
        } else {
          // Delivery failed: re-arm so the next poll tries again.
          for (const limit of due) {
            this.alerted.get(account.id)?.delete(Usage.limitKey(limit));
          }
        }
      }
    } finally {
      this.polling = false;
    }

    return announced;
  },

  /**
   * Report for every stored account, each block labelled with its account.
   * @param {{accounts?: Object[], now?: number}} options
   * @returns {Promise<{sent: boolean, text: string, failed: string[]}>}
   */
  async sendReport({ accounts = null, now = Date.now() } = {}) {
    const state = OAuthManager.loadState();
    const pool = accounts || state.accounts;
    if (pool.length === 0) {
      return { sent: false, text: 'Tidak ada akun tersimpan.', failed: [] };
    }

    const blocks = [];
    const failed = [];
    for (const account of pool) {
      const usage = await this.usageFor(account);
      if (!usage) {
        failed.push(account.label || account.id);
        blocks.push(`${Usage.accountTitle(account, this.isActive(account.id))}\n`
          + 'Gagal mengambil data limit dari upstream.');
        continue;
      }
      blocks.push(Usage.formatAccountUsage(account, usage, {
        active: this.isActive(account.id),
        now
      }));
    }

    const header = `Sisa limit — ${wib.formatFull(now)}`;
    // The header rides on the first message only; bundling keeps each account
    // block whole so an account is never split across two messages.
    const messages = Usage.bundle(blocks).map((chunk, index) =>
      (index === 0 ? `${header}\n\n${chunk}` : chunk));

    let sent = false;
    for (const message of messages) {
      // Sequential rather than parallel: Telegram rate-limits bursts, and a
      // report is not urgent enough to risk a 429.
      if (await Telegram.send(message)) sent = true;
    }

    return { sent, text: messages.join('\n\n'), failed };
  },

  /**
   * Run the scheduled report when the cron says it is due. The schedule is
   * re-read every tick so a change in the web UI applies without a restart.
   * @param {number} now
   * @returns {Promise<boolean>} true when a report was sent
   */
  async tickReports(now = Date.now()) {
    if (this.reporting) return false;

    const expression = Telegram.loadSettings().limit_report_cron;
    if (!expression) {
      this.cronExpression = null;
      this.nextRunAt = null;
      return false;
    }

    if (expression !== this.cronExpression) {
      this.cronExpression = expression;
      this.nextRunAt = this.safeNextRun(expression, now);
      if (this.nextRunAt === null) {
        Logger.warn(`Limit report cron is not usable: ${expression}`);
        return false;
      }
      Logger.info(
        `Limit report scheduled: ${expression} (next ${wib.formatFull(this.nextRunAt)})`
      );
      // A freshly entered schedule waits for its first real slot instead of
      // firing the moment it is saved.
      return false;
    }

    if (this.nextRunAt === null || now < this.nextRunAt) return false;

    this.reporting = true;
    try {
      const result = await this.sendReport({ now });
      if (result.sent) {
        Logger.info('Scheduled limit report sent to Telegram');
      } else {
        Logger.warn('Scheduled limit report could not be delivered');
      }
      return result.sent;
    } finally {
      this.reporting = false;
      // Advance from the current time, not from the slot that just fired: a
      // report that took a minute to send must not queue every slot it missed
      // as a catch-up burst. `now` is the tick's own clock, so a test that
      // drives the scheduler forward does not depend on the wall clock.
      this.nextRunAt = this.safeNextRun(expression, Math.max(now, Date.now()));
    }
  },

  safeNextRun(expression, fromMs) {
    try {
      return Cron.nextRun(expression, fromMs);
    } catch (error) {
      Logger.warn(`Limit report cron error: ${error.message}`);
      return null;
    }
  },

  /**
   * Description and next run for the UI, so the human wording and the machine
   * interpretation of the expression come from the same parser.
   * @param {string} expression
   * @param {number} now
   * @returns {{valid: boolean, description?: string, next_run_at?: string,
   *   next_run?: string, error?: string}}
   */
  describeSchedule(expression, now = Date.now()) {
    if (typeof expression !== 'string' || !expression.trim()) return { valid: true };
    try {
      const at = Cron.nextRun(expression, now);
      return {
        valid: true,
        description: Cron.describe(expression),
        next_run_at: at,
        next_run: at === null ? 'tidak akan pernah jalan' : wib.formatFull(at)
      };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }
};

module.exports = LimitWatch;
