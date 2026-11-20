const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const Logger = require('./Logger');
const { CLAUDE_CLI_VERSION } = require('./cloaking');

const OAUTH_CONFIG = {
  client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorize_url: 'https://claude.ai/oauth/authorize',
  token_url: 'https://console.anthropic.com/v1/oauth/token',
  redirect_uri: 'https://console.anthropic.com/oauth/code/callback', // Anthropic's callback page (shows code to user)
  scope: 'org:create_api_key user:profile user:inference'
};

// Used when a 429 carries no usable reset header. Short enough that a leaked
// limit does not park an account for long, long enough that an account that
// really is rate limited is not retried on every request.
const DEFAULT_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

// Weekly subscription windows are the longest real reset. A reset header past
// this is junk (or a unit change), and storing it verbatim parked the account
// for years and made the 429 error's ISO date throw.
const MAX_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

// One Anthropic login can belong to several organizations, and one
// organization can hold several user accounts, so only the pair identifies a
// credential. Email is the fallback for a migrated single-token account, which
// has no UUIDs at all.
function accountKey(account) {
  const uuid = account.account_uuid || null;
  const org = account.organization_uuid || null;
  const email = account.email ? String(account.email).toLowerCase() : null;

  if (uuid && org) return `${uuid}:${org}`;
  if (uuid) return uuid;
  if (email) return `email:${email}`;
  return null;
}

class OAuthManager {
  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE;
    // Legacy single-token file: read once to migrate, then removed.
    this.tokenPath = path.join(home, '.claude-code-proxy', 'tokens.json');
    this.statePath = path.join(home, '.claude-code-proxy', 'accounts.json');
    this.refreshPromises = new Map(); // account id -> in-flight refresh
  }

  /**
   * Generate PKCE code verifier, challenge, and state for OAuth flow
   * @returns {{code_verifier: string, code_challenge: string, state: string}}
   */
  generatePKCE() {
    // Generate random code verifier (43-128 chars)
    const code_verifier = crypto.randomBytes(32).toString('base64url');

    // Generate code challenge using S256 method
    const code_challenge = crypto
      .createHash('sha256')
      .update(code_verifier)
      .digest('base64url');

    // Generate random state for CSRF protection (32 bytes to match OpenCode)
    const state = crypto.randomBytes(32).toString('base64url');

    return { code_verifier, code_challenge, state };
  }

  /**
   * Build authorization URL for user to visit
   * @param {{code_challenge: string, state: string}} pkce
   * @returns {string} Authorization URL
   */
  buildAuthorizationURL(pkce) {
    const params = new URLSearchParams({
      code: 'true', // Required: tells Anthropic to display the authorization code
      client_id: OAUTH_CONFIG.client_id,
      response_type: 'code',
      redirect_uri: OAUTH_CONFIG.redirect_uri,
      scope: OAUTH_CONFIG.scope,
      code_challenge: pkce.code_challenge,
      code_challenge_method: 'S256',
      state: pkce.state
    });

    return `${OAUTH_CONFIG.authorize_url}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access and refresh tokens
   * @param {string} code - Authorization code from callback
   * @param {string} code_verifier - PKCE code verifier
   * @param {string} state - State parameter from callback
   * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>}
   */
  async exchangeCodeForTokens(code, code_verifier, state) {
    const payload = JSON.stringify({
      grant_type: 'authorization_code',
      code: code,
      state: state,
      client_id: OAUTH_CONFIG.client_id,
      code_verifier: code_verifier,
      redirect_uri: OAUTH_CONFIG.redirect_uri
    });

    try {
      const response = await this._makeTokenRequest(payload);
      Logger.info('Successfully exchanged authorization code for tokens');
      return response;
    } catch (error) {
      Logger.error('Failed to exchange code for tokens', error);
      throw error;
    }
  }

  /**
   * Refresh one account's access token.
   * Single-flight per account: the same id joins the in-flight request, other
   * ids refresh in parallel, so a slow refresh on one account cannot block
   * failover to another.
   * @param {string} accountId
   * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>}
   */
  refreshAccessToken(accountId) {
    const inFlight = this.refreshPromises.get(accountId);
    if (inFlight) {
      Logger.debug(`Token refresh already in progress for ${accountId}, waiting...`);
      return inFlight;
    }

    // Cleanup is chained rather than an in-body try/finally. The body can throw
    // before its first network await (unknown account, no refresh token), and
    // an in-body finally then ran before this promise was registered: the map
    // kept a settled rejection and every later refresh of that id returned it.
    const promise = (async () => {
      const state = this.loadState();
      const account = state.accounts.find(a => a.id === accountId);
      if (!account) {
        throw new Error(`Account not found: ${accountId}`);
      }
      if (!account.refresh_token) {
        throw new Error('No refresh token available');
      }

      const payload = JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: account.refresh_token,
        client_id: OAUTH_CONFIG.client_id
      });

      const response = await this._makeTokenRequest(payload);
      Logger.info('Successfully refreshed access token');

      // Re-read state inside _updateAccount and patch only the token fields:
      // a concurrent 429 may have written a limit for this account meanwhile,
      // and a whole-state write here would throw it away.
      this._updateAccount(accountId, {
        access_token: response.access_token,
        refresh_token: response.refresh_token || account.refresh_token,
        expires_at: Date.now() + ((Number.isFinite(response.expires_in) ? response.expires_in : 3600) * 1000)
      });

      return response;
    })().finally(() => {
      if (this.refreshPromises.get(accountId) === promise) {
        this.refreshPromises.delete(accountId);
      }
    });

    this.refreshPromises.set(accountId, promise);
    return promise;
  }

  /**
   * Make an HTTPS request to the token endpoint
   * @param {string} payload - JSON payload to send
   * @returns {Promise<Object>} Token response
   * @private
   */
  _makeTokenRequest(payload) {
    return new Promise((resolve, reject) => {
      const url = new URL(OAUTH_CONFIG.token_url);

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (error) {
              reject(new Error(`Failed to parse token response: ${error.message}`));
            }
          } else {
            reject(new Error(`Token request failed with status ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Read the account store. Migrates a legacy tokens.json once.
   * @returns {{active_account_id: string|null, accounts: Object[]}}
   */
  loadState() {
    try {
      if (fs.existsSync(this.statePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        return {
          active_account_id: parsed.active_account_id ?? null,
          accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
        };
      }
    } catch (error) {
      Logger.error('Failed to load accounts from file', error);
      return { active_account_id: null, accounts: [] };
    }

    // No store yet: adopt the single credential older versions wrote.
    try {
      if (fs.existsSync(this.tokenPath)) {
        const legacy = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
        if (legacy && legacy.access_token && legacy.refresh_token) {
          const account = {
            id: crypto.randomUUID(),
            label: 'Account 1',
            email: null,
            account_uuid: null,
            organization_uuid: null,
            access_token: legacy.access_token,
            refresh_token: legacy.refresh_token,
            expires_at: typeof legacy.expires_at === 'number' ? legacy.expires_at : null,
            limited_until: null,
            limited_reason: null,
            last_limit_at: null,
            created_at: Date.now()
          };
          const state = { active_account_id: account.id, accounts: [account] };
          this.saveState(state);
          try {
            fs.unlinkSync(this.tokenPath);
            Logger.info('Migrated tokens.json to accounts.json');
          } catch (error) {
            // The accounts are already durable, and a stale legacy file is
            // harmless because accounts.json wins from now on.
            Logger.warn(`Failed to remove legacy token file: ${error.message}`);
          }
          return state;
        }
      }
    } catch (error) {
      Logger.error('Failed to migrate legacy tokens file', error);
    }

    return { active_account_id: null, accounts: [] };
  }

  /**
   * Write the account store atomically at mode 0600.
   * @param {{active_account_id: string|null, accounts: Object[]}} state
   */
  saveState(state) {
    try {
      const dir = path.dirname(this.statePath);
      fs.mkdirSync(dir, { recursive: true });

      const tmpPath = `${this.statePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') {
        fs.chmodSync(tmpPath, 0o600);
      }
      fs.renameSync(tmpPath, this.statePath);
    } catch (error) {
      Logger.error('Failed to save accounts to file', error);
      throw error;
    }
  }

  /**
   * Look up who a token belongs to, for callers whose token response carried
   * no account/organization. Never throws: a login must not fail over a
   * missing label.
   * @param {string} accessToken
   * @returns {Promise<{account_uuid: string|null, email: string|null, organization_uuid: string|null}|null>}
   */
  fetchAccountIdentity(accessToken) {
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/api/oauth/profile',
        method: 'GET',
        timeout: 5000,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'User-Agent': `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`
        }
      }, (res) => {
        let data = '';

        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            Logger.warn(`OAuth profile lookup failed with status ${res.statusCode}`);
            resolve(null);
            return;
          }
          try {
            const body = JSON.parse(data);
            resolve({
              account_uuid: body.account?.uuid ?? null,
              email: body.account?.email ?? body.account?.email_address ?? null,
              organization_uuid: body.organization?.uuid ?? null
            });
          } catch (error) {
            Logger.warn(`Failed to parse OAuth profile: ${error.message}`);
            resolve(null);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error('OAuth profile lookup timed out'));
      });

      req.on('error', (error) => {
        Logger.warn(`OAuth profile lookup failed: ${error.message}`);
        resolve(null);
      });

      req.end();
    });
  }

  /**
   * Add or refresh one account in the pool.
   * @param {{access_token: string, refresh_token: string, expires_at: number}} tokens
   * @param {{account_uuid?: string|null, email?: string|null, organization_uuid?: string|null}} identity
   * @returns {Object} sanitized account
   */
  addAccount(tokens, identity = {}) {
    const now = Date.now();
    const state = this.loadState();
    const email = identity.email ? String(identity.email) : null;
    const key = accountKey(identity);

    let existing = key ? state.accounts.find(a => accountKey(a) === key) : null;

    // A migrated account has no UUIDs, so its email is the only link back.
    if (!existing && email) {
      existing = state.accounts.find(a =>
        !a.account_uuid && a.email && String(a.email).toLowerCase() === email.toLowerCase()
      );
    }

    // Migration writes an account with no identity at all, because tokens.json
    // carries none. A login cannot match that slot by key or email, so an
    // identified login takes it over: it is the pre-upgrade credential, and
    // leaving it active beside a fresh account is exactly the post-upgrade
    // 401 this pool must not produce.
    if (!existing && (key || email)) {
      const identityless = state.accounts.filter(a => accountKey(a) === null);
      if (identityless.length === 1) {
        existing = identityless[0];
      }
    }

    let account;
    if (existing) {
      if (email && !existing.email) {
        existing.label = email;
        existing.email = email;
      } else if (email) {
        existing.email = email;
      }
      existing.account_uuid = identity.account_uuid ?? existing.account_uuid ?? null;
      existing.organization_uuid = identity.organization_uuid ?? existing.organization_uuid ?? null;
      existing.access_token = tokens.access_token;
      existing.refresh_token = tokens.refresh_token || existing.refresh_token;
      existing.expires_at = tokens.expires_at;
      existing.limited_until = null;
      existing.limited_reason = null;
      existing.last_limit_at = null;
      account = existing;
    } else {
      account = {
        id: crypto.randomUUID(),
        label: email || `Account ${state.accounts.length + 1}`,
        email,
        account_uuid: identity.account_uuid ?? null,
        organization_uuid: identity.organization_uuid ?? null,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        limited_until: null,
        limited_reason: null,
        last_limit_at: null,
        created_at: now
      };
      state.accounts.push(account);
    }

    // A login only claims the active slot when nobody healthy holds it, so
    // adding an account never moves traffic off the account already in use.
    const activeExists = state.accounts.some(a => a.id === state.active_account_id);
    if (!state.active_account_id || !activeExists) {
      state.active_account_id = account.id;
    }

    this.saveState(state);
    return this._sanitizeAccount(account, state.active_account_id, now);
  }

  /**
   * Register the result of /auth/callback.
   * @param {Object} tokens - token endpoint response
   * @returns {Promise<Object>} sanitized account
   */
  async addAccountFromTokenResponse(tokens) {
    const identity = {
      account_uuid: tokens.account?.uuid ?? null,
      email: tokens.account?.email_address ?? tokens.account?.email ?? null,
      organization_uuid: tokens.organization?.uuid ?? null
    };

    // The pair is the dedupe key, so a missing half is worth one lookup.
    if (!identity.account_uuid || !identity.organization_uuid) {
      const profile = await this.fetchAccountIdentity(tokens.access_token);
      if (profile) {
        identity.account_uuid = identity.account_uuid ?? profile.account_uuid;
        identity.email = identity.email ?? profile.email;
        identity.organization_uuid = identity.organization_uuid ?? profile.organization_uuid;
      }
    }

    const expiresIn = Number.isFinite(tokens.expires_in) ? tokens.expires_in : 3600;
    const account = this.addAccount({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + expiresIn * 1000
    }, identity);

    Logger.info(`OAuth account added: ${account.label} (${this.accountCount()} total)`);
    return account;
  }

  _sanitizeAccount(account, activeAccountId, now = Date.now()) {
    const limited = this._isLimited(account, now);
    return {
      id: account.id,
      label: account.label,
      email: account.email ?? null,
      expires_at: account.expires_at ?? null,
      limited_until: limited ? account.limited_until : null,
      limited,
      limited_reason: limited ? (account.limited_reason ?? null) : null,
      active: account.id === activeAccountId
    };
  }

  _isLimited(account, now = Date.now()) {
    return !!account.limited_until && account.limited_until > now;
  }

  /**
   * Move the active pointer to the next usable account, scanning circularly
   * from just after fromId, and return it. Mutates state only.
   * @returns {Object|null} null when every account is limited
   */
  _advanceActive(state, fromId, now) {
    const accounts = state.accounts;
    const count = accounts.length;
    if (count === 0) return null;

    const start = fromId ? accounts.findIndex(a => a.id === fromId) : -1;
    for (let step = 1; step <= count; step += 1) {
      const account = accounts[((start + step) % count + count) % count];
      if (!this._isLimited(account, now)) {
        state.active_account_id = account.id;
        return account;
      }
    }
    return null;
  }

  /**
   * The account requests should use right now.
   * Expiry of a limit never moves traffic on its own: a healthy active account
   * keeps the slot even after another account's limit resets.
   * @returns {Object|null}
   */
  getActiveAccount() {
    const now = Date.now();
    const state = this.loadState();
    const active = state.accounts.find(a => a.id === state.active_account_id);

    if (active && !this._isLimited(active, now)) {
      return active;
    }

    const next = this._advanceActive(state, state.active_account_id, now);
    if (next) {
      this.saveState(state);
    }
    return next;
  }

  /**
   * Record a 429 for one account and move off it when it was the active one.
   * @param {string} accountId
   * @param {{resetAtMs?: number|null, reason?: string}} options
   * @returns {Object|null} usable active account
   */
  markAccountLimited(accountId, { resetAtMs = null, reason = 'rate_limit' } = {}) {
    const now = Date.now();
    const state = this.loadState();
    const account = state.accounts.find(a => a.id === accountId);

    if (!account) {
      return this.getActiveAccount();
    }

    account.limited_until = (resetAtMs && resetAtMs > now)
      ? Math.min(resetAtMs, now + MAX_LIMIT_MS)
      : now + DEFAULT_LIMIT_COOLDOWN_MS;
    account.limited_reason = reason;
    account.last_limit_at = now;

    // A late 429 for an account that already lost the slot must not move the
    // pointer past the account now serving traffic.
    const active = state.accounts.find(a => a.id === state.active_account_id);
    const activeUsable = active && active.id !== accountId && !this._isLimited(active, now);

    const next = activeUsable
      ? active
      : this._advanceActive(state, state.active_account_id, now);

    this.saveState(state);
    return next;
  }

  _updateAccount(accountId, patch) {
    const state = this.loadState();
    const account = state.accounts.find(a => a.id === accountId);
    if (!account) {
      return null;
    }
    Object.assign(account, patch);
    this.saveState(state);
    return account;
  }

  /**
   * Pool state for /auth/status and the startup banner. Never exposes tokens.
   */
  getStatus() {
    const now = Date.now();
    const state = this.loadState();
    const accounts = state.accounts.map(a => this._sanitizeAccount(a, state.active_account_id, now));

    let earliestResetAt = null;
    for (const account of accounts) {
      if (!account.limited) continue;
      if (earliestResetAt === null || account.limited_until < earliestResetAt) {
        earliestResetAt = account.limited_until;
      }
    }

    return {
      authenticated: state.accounts.some(a => a.access_token && a.refresh_token),
      active_account_id: state.active_account_id ?? null,
      all_limited: accounts.length > 0 && accounts.every(a => a.limited),
      earliest_reset_at: earliestResetAt,
      accounts
    };
  }

  accountCount() {
    return this.loadState().accounts.length;
  }

  getEarliestResetMs() {
    const now = Date.now();
    let earliest = null;
    for (const account of this.loadState().accounts) {
      if (!account.limited_until || account.limited_until <= now) continue;
      if (earliest === null || account.limited_until < earliest) {
        earliest = account.limited_until;
      }
    }
    return earliest;
  }

  /**
   * Check if the pool holds at least one usable credential
   * @returns {boolean} True if authenticated
   */
  isAuthenticated() {
    return this.loadState().accounts.some(a => a.access_token && a.refresh_token);
  }

  /**
   * Get one account's access token, refreshing it if it is expired or expiring
   * within a minute. A missing expires_at counts as expired.
   * @param {string} accountId
   * @returns {Promise<string>} Valid access token
   */
  async getValidAccessToken(accountId) {
    const account = this.loadState().accounts.find(a => a.id === accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    if (account.expires_at && account.expires_at > Date.now() + 60000) {
      return account.access_token;
    }

    Logger.info('Access token expired or expiring soon, refreshing...');
    await this.refreshAccessToken(accountId);

    const refreshed = this.loadState().accounts.find(a => a.id === accountId);
    if (!refreshed || !refreshed.access_token) {
      throw new Error(`Account not found: ${accountId}`);
    }
    return refreshed.access_token;
  }

  /**
   * Delete every stored account (logout)
   */
  logout() {
    try {
      for (const filePath of [this.statePath, this.tokenPath]) {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
      this.refreshPromises.clear();
      Logger.info('Tokens deleted successfully');
    } catch (error) {
      Logger.error('Failed to delete tokens', error);
      throw error;
    }
  }

}

// Export singleton instance
module.exports = new OAuthManager();
