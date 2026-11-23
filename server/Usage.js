'use strict';

const https = require('https');
const OAuthManager = require('./OAuthManager');
const wib = require('./wib');
const { CLAUDE_CLI_VERSION } = require('./cloaking');

// Same endpoint and headers as the reference ~/.hermes/scripts/limit.sh: this
// is the call Claude Code's own status line makes with a subscription token,
// so it has to carry the same client identity.
const USAGE_HOST = 'api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 10 * 1000;

const LIMIT_TITLES = {
  session: '5 jam',
  weekly_all: '7 hari',
  weekly_opus: '7h Opus',
  weekly_sonnet: '7h Sonnet',
  weekly_cowork: '7h Cowork'
};

const finiteOr = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const isoToMs = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// limit.sh prints the raw response body's limits; a missing array there is an
// error. Here the older top-level objects are still accepted, so an upstream
// that only sends five_hour/seven_day keeps producing a usable report.
const fromTopLevel = (root, key, kind) => {
  const source = root[key];
  if (!source || typeof source !== 'object') return null;
  const percent = finiteOr(source.utilization);
  if (percent === null) return null;
  return {
    kind,
    group: kind === 'session' ? 'session' : 'weekly',
    percent,
    severity: 'normal',
    resetsAt: isoToMs(source.resets_at),
    isActive: false,
    scope: null
  };
};

/**
 * @param {Object} body the /api/oauth/usage response
 * @returns {{limits: Object[], spend: Object|null, extraUsage: Object|null}|null}
 *   null when the body carries no limit information at all
 */
const normalize = (body) => {
  if (!body || typeof body !== 'object') return null;

  const limits = [];
  if (Array.isArray(body.limits)) {
    for (const limit of body.limits) {
      if (!limit || typeof limit !== 'object') continue;
      const percent = finiteOr(limit.percent);
      if (percent === null) continue;
      limits.push({
        kind: typeof limit.kind === 'string' ? limit.kind : 'unknown',
        group: typeof limit.group === 'string' ? limit.group : null,
        percent,
        severity: typeof limit.severity === 'string' ? limit.severity : 'normal',
        resetsAt: isoToMs(limit.resets_at),
        isActive: limit.is_active === true,
        scope: limit.scope && typeof limit.scope === 'object' ? limit.scope : null
      });
    }
  }

  if (limits.length === 0) {
    for (const [key, kind] of [['five_hour', 'session'], ['seven_day', 'weekly_all']]) {
      const limit = fromTopLevel(body, key, kind);
      if (limit) limits.push(limit);
    }
  }

  if (limits.length === 0) return null;

  return {
    limits,
    spend: body.spend && typeof body.spend === 'object' ? body.spend : null,
    extraUsage: body.extra_usage && typeof body.extra_usage === 'object' ? body.extra_usage : null,
    root: body
  };
};

// weekly_scoped carries no fixed name: its label lives in .scope.
const limitTitle = (limit) => {
  if (limit.kind === 'weekly_scoped') {
    const scope = limit.scope || {};
    const name = (scope.model && scope.model.display_name) || scope.surface || 'scoped';
    return `7h ${name}`;
  }
  return LIMIT_TITLES[limit.kind] || limit.kind;
};

// One cell per 10%, ten cells wide, like the reference script.
const bar = (percent) => {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
};

const flag = (severity) => {
  if (severity === 'critical') return '‼';
  if (severity === 'warning') return '⚠';
  return ' ';
};

const money = (value) => {
  if (!value || typeof value !== 'object') return null;
  const amount = finiteOr(value.amount_minor);
  const exponent = finiteOr(value.exponent, 2);
  if (amount === null || exponent === null) return null;
  return Math.round((amount / (10 ** exponent)) * 100) / 100;
};

// The reference script reads used_dollars/limit_dollars off the top-level
// five_hour/seven_day objects, which only subscription accounts report.
const dollars = (limit, root) => {
  const key = { session: 'five_hour', weekly_all: 'seven_day' }[limit.kind];
  const source = key && root ? root[key] : null;
  if (!source || source.used_dollars === null || source.used_dollars === undefined) return '';
  return `  $${source.used_dollars}/$${source.limit_dollars}`;
};

const formatLimitLine = (limit, root, now) => {
  const percentText = String(limit.percent).padStart(3);
  let line = `${limitTitle(limit).padEnd(10)}${bar(limit.percent)}  ${percentText}% ${flag(limit.severity)}`;

  if (limit.resetsAt) {
    line += `  reset ${wib.formatShort(limit.resetsAt)}  (${wib.formatRemaining(limit.resetsAt - now)})`;
  } else {
    line += '  belum terpakai';
  }

  line += dollars(limit, root);
  if (limit.isActive) line += '  ←';
  return line;
};

const formatSpendLine = (spend) => {
  if (!spend || spend.enabled !== true) return null;
  const percent = finiteOr(spend.percent, 0);
  const used = money(spend.used);
  const limit = money(spend.limit);
  const balance = money(spend.balance);
  let line = `${'Kredit'.padEnd(10)}${bar(percent)}  ${String(percent).padStart(3)}%`
    + `    $${used === null ? '—' : used} / $${limit === null ? '—' : limit}`;
  if (balance !== null) line += `  sisa $${balance}`;
  return line;
};

const formatExtraUsageLine = (extraUsage) => (
  extraUsage && extraUsage.spend_limit_reached === true
    ? `${'Kredit'.padEnd(10)}batas kredit tercapai`
    : null
);

/**
 * One label per account, so a message can never be mistaken for another
 * account's. The e-mail is shown when the label is something else.
 * @param {Object} account stored account
 * @param {boolean} active whether it is the proxy's active account
 * @returns {string}
 */
const accountTitle = (account, active) => {
  const label = account.label || account.id;
  const email = account.email && account.email !== label ? ` (${account.email})` : '';
  const marks = [];
  if (active) marks.push('aktif');
  if (account.disabled) marks.push('nonaktif');
  return `Akun: ${label}${email}${marks.length ? ` [${marks.join(', ')}]` : ''}`;
};

/**
 * Reference-script report for one account, plus the account label the script
 * has no concept of.
 * @param {Object} account stored account
 * @param {Object} usage normalized usage
 * @param {{active?: boolean, now?: number}} options
 * @returns {string}
 */
const formatAccountUsage = (account, usage, { active = false, now = Date.now() } = {}) => {
  const lines = [accountTitle(account, active)];
  for (const limit of usage.limits) {
    lines.push(formatLimitLine(limit, usage.root, now));
  }
  const spend = formatSpendLine(usage.spend);
  if (spend) lines.push(spend);
  const extra = formatExtraUsageLine(usage.extraUsage);
  if (extra) lines.push(extra);
  return lines.join('\n');
};

const fetchUsageBody = (token) => new Promise((resolve, reject) => {
  const req = https.request({
    hostname: USAGE_HOST,
    port: 443,
    path: USAGE_PATH,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'X-App': 'cli',
      'User-Agent': `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`
    }
  }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => {
      resolve({ statusCode: response.statusCode, body });
    });
    response.on('error', reject);
  });

  req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('usage request timed out')));
  req.on('error', reject);
  req.end();
});

const parseBody = (raw, statusCode) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`usage response was not JSON (HTTP ${statusCode}): ${raw.slice(0, 120)}`);
  }
  const usage = normalize(parsed);
  if (!usage) {
    throw new Error(`usage response had no limits (HTTP ${statusCode}): ${raw.slice(0, 120)}`);
  }
  return usage;
};

/**
 * Current subscription usage for one stored account. A 401 gets one refresh
 * and one retry; anything else is thrown with a message fit for a notification.
 * @param {Object} account stored account
 * @returns {Promise<Object>} normalized usage
 */
const getAccountUsage = async (account) => {
  if (!account || !account.id) throw new Error('account is missing an id');

  const token = await OAuthManager.getValidAccessToken(account.id);
  const first = await fetchUsageBody(token);
  if (first.statusCode === 401) {
    // The stored token looked valid but upstream disagreed; refresh once, the
    // same way the request path recovers from a stale token.
    await OAuthManager.refreshAccessToken(account.id);
    const refreshed = await OAuthManager.getValidAccessToken(account.id);
    const second = await fetchUsageBody(refreshed);
    return parseBody(second.body, second.statusCode);
  }

  return parseBody(first.body, first.statusCode);
};

/**
 * Limits whose remaining allowance reached the threshold. Only windows that
 * can run out and lock the account out are considered: the 5-hour session and
 * the 7-day limits (including model-scoped ones).
 * @param {Object} usage normalized usage
 * @param {number} thresholdPercent remaining percentage, e.g. 10
 * @returns {Object[]} the matching limits
 */
const lowLimits = (usage, thresholdPercent) => {
  const floor = 100 - thresholdPercent;
  return usage.limits.filter(limit => {
    const weekly = typeof limit.kind === 'string' && limit.kind.startsWith('weekly');
    if (limit.kind !== 'session' && !weekly) return false;
    return limit.percent >= floor;
  });
};

/**
 * Stable key for one limit across polls: it changes when a new window starts,
 * which is what re-arms the alert.
 * @param {Object} limit
 * @returns {string}
 */
const limitKey = (limit) => {
  const scope = limit.scope
    ? (limit.scope.model && (limit.scope.model.id || limit.scope.model.display_name))
      || limit.scope.surface
      || ''
    : '';
  return `${limit.kind}:${scope}`;
};

const remainingOf = (limit) => {
  const remaining = 100 - Number(limit.percent);
  // 99.6% used is not exhausted, but rounding it to 0 would claim it is while
  // showing "sisa 0%" — the same thing "habis" is supposed to mean.
  if (remaining <= 0) return 0;
  return Math.max(1, Math.round(remaining));
};

// True only when the upstream reports the window fully used, not when it
// merely rounds down to zero.
const isExhausted = (limit) => Number(limit.percent) >= 100;

const resetText = (limit, now) => (
  limit.resetsAt
    ? `${wib.formatFull(limit.resetsAt)} (sisa ${wib.formatRemaining(limit.resetsAt - now)})`
    : 'belum ada jadwal reset'
);

/**
 * One alert per account, listing every window that ran low, so the reader does
 * not have to stitch several messages together to see which account is at
 * risk. Each line goes through the same formatter as the report, which is what
 * keeps the wording and the bars identical.
 * @param {Object} account stored account
 * @param {Object[]} limits one or more low limits for that account
 * @param {{active?: boolean, now?: number}} options
 * @returns {string}
 */
const formatLowLimitAlert = (account, limits, { active = false, now = Date.now() } = {}) => {
  const list = Array.isArray(limits) ? limits : [limits];
  const critical = list.some(limit => limit.severity === 'critical');

  // "menipis" (running low) and "habis" (used up) are different states: a
  // window at 100% used is out, and calling that "low" understates it. Each
  // window in the summary gets the wording that matches its own state, and the
  // headline only says "habis" when every listed window is actually out.
  const allOut = list.every(isExhausted);
  const state = allOut ? 'habis' : 'menipis';
  const summary = allOut
    // Repeating "habis" after "Limit habis:" reads badly; the title is enough.
    ? list.map(limitTitle).join(', ')
    : list
      .map(limit => `${limitTitle(limit)} ${isExhausted(limit) ? 'habis' : `sisa ${remainingOf(limit)}%`}`)
      .join(', ');

  const lines = [
    `${critical ? '‼' : '⚠'} Limit ${state}: ${summary}`,
    accountTitle(account, active)
  ];

  for (const limit of list) {
    let line = `${limitTitle(limit).padEnd(10)}${bar(limit.percent)}  ${String(limit.percent).padStart(3)}% `
      + `${flag(limit.severity)}  reset ${resetText(limit, now)}`;
    if (limit.isActive) line += '  ←';
    lines.push(line);
  }

  return lines.join('\n');
};

// A Telegram message is capped at 4096 characters. Leaving headroom means a
// long list of model-scoped limits is split rather than rejected.
const MESSAGE_LIMIT = 3500;

// Telegram rejects anything longer than this outright, so a single oversized
// block is cut rather than costing the whole report.
const TELEGRAM_HARD_LIMIT = 4096;
const TRUNCATION_MARK = '\n… (dipotong)';

/**
 * Join per-account blocks into as few messages as fit.
 * @param {string[]} blocks
 * @param {number} limit
 * @returns {string[]}
 */
const bundle = (blocks, limit = MESSAGE_LIMIT) => {
  const messages = [];
  let current = '';
  for (const block of blocks) {
    const trimmed = block.length > TELEGRAM_HARD_LIMIT - TRUNCATION_MARK.length
      ? block.slice(0, TELEGRAM_HARD_LIMIT - TRUNCATION_MARK.length) + TRUNCATION_MARK
      : block;
    const candidate = current ? `${current}\n\n${trimmed}` : trimmed;
    if (candidate.length > limit && current) {
      messages.push(current);
      current = trimmed;
      continue;
    }
    current = candidate;
  }
  if (current) messages.push(current);
  return messages;
};

/* -------------------------------------------------------------------------
 * JSON snapshots for the /limits endpoint.
 *
 * The Telegram messages are for a human reading prose; a machine consumer
 * wants the numbers and nothing to parse. These builders keep the same source
 * data (one normalization pass, same titles) so the two can never disagree.
 * ---------------------------------------------------------------------- */

// A Date cannot represent anything past this, and a store can hold garbage.
const ISO_MAX_MS = 8.64e15;

const isoOrNull = (ms) => (
  Number.isFinite(ms) && Math.abs(ms) <= ISO_MAX_MS ? new Date(ms).toISOString() : null
);

const round2 = (value) => Math.round(value * 100) / 100;

const snapshotLimit = (limit, now) => ({
  kind: limit.kind,
  title: limitTitle(limit),
  percent_used: round2(limit.percent),
  // Not rounded to a whole number: a consumer drawing a gauge wants the real
  // figure, and 0.4% left is not the same as none.
  percent_remaining: round2(Math.max(0, 100 - limit.percent)),
  severity: limit.severity,
  exhausted: isExhausted(limit),
  is_active: limit.isActive,
  resets_at: isoOrNull(limit.resetsAt),
  resets_in_seconds: limit.resetsAt
    ? Math.max(0, Math.round((limit.resetsAt - now) / 1000))
    : null,
  scope: limit.scope
    ? {
        model: limit.scope.model?.display_name ?? null,
        surface: limit.scope.surface ?? null
      }
    : null
});

// Only when the upstream reports credit spending at all; null otherwise, so a
// consumer can tell "no credits" from "not applicable".
const snapshotCredits = (spend) => {
  if (!spend || spend.enabled !== true) return null;
  return {
    percent_used: round2(finiteOr(spend.percent, 0)),
    used: money(spend.used),
    limit: money(spend.limit),
    balance: money(spend.balance),
    currency: spend.used?.currency ?? null
  };
};

/**
 * @param {Object} usage normalized usage
 * @param {number} now
 * @returns {{limits: Object[], credits: Object|null}}
 */
const snapshotUsage = (usage, now = Date.now()) => ({
  limits: usage.limits.map(limit => snapshotLimit(limit, now)),
  credits: snapshotCredits(usage.spend)
});

// One minute: long enough that a dashboard polling every few seconds does not
// turn into an upstream flood, short enough that the numbers still move.
const DEFAULT_CACHE_MS = 60 * 1000;

const usageCache = new Map(); // account id -> {usage, fetchedAt}
const usageInFlight = new Map(); // account id -> in-flight promise

/**
 * Cached variant of getAccountUsage for callers that may be polled often.
 * Concurrent callers share one upstream request, and a failed refresh falls
 * back to the last good snapshot instead of losing the account entirely.
 * @param {Object} account stored account
 * @param {{now?: number, maxAgeMs?: number, refresh?: boolean}} options
 * @returns {Promise<{usage: Object, cached: boolean, fetchedAt: number, stale?: boolean}>}
 */
const getAccountUsageCached = async (account, {
  now = Date.now(),
  maxAgeMs = DEFAULT_CACHE_MS,
  refresh = false
} = {}) => {
  const cached = usageCache.get(account.id);
  if (!refresh && cached && now - cached.fetchedAt < maxAgeMs) {
    return { usage: cached.usage, cached: true, fetchedAt: cached.fetchedAt };
  }

  // Joining an in-flight fetch means a burst of polls costs one request.
  const pending = usageInFlight.get(account.id);
  if (pending) {
    const usage = await pending;
    return {
      usage,
      cached: true,
      fetchedAt: usageCache.get(account.id)?.fetchedAt ?? now
    };
  }

  const promise = getAccountUsage(account)
    .then(usage => {
      usageCache.set(account.id, { usage, fetchedAt: Date.now() });
      return usage;
    })
    .finally(() => {
      if (usageInFlight.get(account.id) === promise) usageInFlight.delete(account.id);
    });
  usageInFlight.set(account.id, promise);

  try {
    const usage = await promise;
    return { usage, cached: false, fetchedAt: usageCache.get(account.id).fetchedAt };
  } catch (error) {
    if (cached) return { usage: cached.usage, cached: true, fetchedAt: cached.fetchedAt, stale: true };
    throw error;
  }
};

const clearUsageCache = () => {
  usageCache.clear();
  usageInFlight.clear();
};


module.exports = {
  normalize,
  getAccountUsage,
  getAccountUsageCached,
  clearUsageCache,
  snapshotUsage,
  snapshotLimit,
  formatAccountUsage,
  formatLowLimitAlert,
  lowLimits,
  limitKey,
  limitTitle,
  bundle,
  bar,
  accountTitle,
  MESSAGE_LIMIT,
  DEFAULT_CACHE_MS
};
