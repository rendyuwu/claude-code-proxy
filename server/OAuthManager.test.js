const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nock = require('nock');
const OAuthManager = require('./OAuthManager');

// Mock the Logger module
jest.mock('./Logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

const TEST_DIR = path.join(__dirname, '.test-accounts');
const STATE_PATH = path.join(TEST_DIR, 'accounts.json');
const TOKEN_PATH = path.join(TEST_DIR, 'tokens.json');

const tokensFor = (suffix, expiresAt = Date.now() + 3600000) => ({
  access_token: `token-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  expires_at: expiresAt
});

const identityFor = (suffix) => ({
  account_uuid: `uuid-${suffix}`,
  organization_uuid: `org-${suffix}`,
  email: `${suffix}@example.com`
});

const addAccount = (suffix, identity = identityFor(suffix)) =>
  OAuthManager.addAccount(tokensFor(suffix), identity);

const readState = () => JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

describe('OAuthManager', () => {
  beforeAll(() => {
    // An unexpected refresh must fail fast instead of reaching the network.
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  beforeEach(() => {
    OAuthManager.statePath = STATE_PATH;
    OAuthManager.tokenPath = TOKEN_PATH;
    OAuthManager.refreshPromises.clear();

    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    nock.cleanAll();
  });

  describe('generatePKCE', () => {
    it('should generate valid PKCE parameters', () => {
      const pkce = OAuthManager.generatePKCE();

      expect(pkce).toHaveProperty('code_verifier');
      expect(pkce).toHaveProperty('code_challenge');
      expect(pkce).toHaveProperty('state');

      expect(typeof pkce.code_verifier).toBe('string');
      expect(typeof pkce.code_challenge).toBe('string');
      expect(typeof pkce.state).toBe('string');

      expect(pkce.code_verifier.length).toBeGreaterThan(0);
      expect(pkce.code_challenge.length).toBeGreaterThan(0);
      expect(pkce.state.length).toBeGreaterThan(0);
    });

    it('should generate different values on each call', () => {
      const pkce1 = OAuthManager.generatePKCE();
      const pkce2 = OAuthManager.generatePKCE();

      expect(pkce1.code_verifier).not.toBe(pkce2.code_verifier);
      expect(pkce1.code_challenge).not.toBe(pkce2.code_challenge);
      expect(pkce1.state).not.toBe(pkce2.state);
    });

    it('should generate code_challenge from code_verifier using SHA256', () => {
      const pkce = OAuthManager.generatePKCE();

      const expectedChallenge = crypto
        .createHash('sha256')
        .update(pkce.code_verifier)
        .digest('base64url');

      expect(pkce.code_challenge).toBe(expectedChallenge);
    });
  });

  describe('buildAuthorizationURL', () => {
    it('should build valid authorization URL', () => {
      const pkce = {
        code_challenge: 'test-challenge',
        state: 'test-state'
      };

      const url = OAuthManager.buildAuthorizationURL(pkce);

      expect(url).toContain('https://claude.ai/oauth/authorize');
      expect(url).toContain('client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      expect(url).toContain('response_type=code');
      expect(url).toContain('code_challenge=test-challenge');
      expect(url).toContain('code_challenge_method=S256');
      expect(url).toContain('state=test-state');
      expect(url).toContain('scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference');
      expect(url).toContain('redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback');
    });
  });

  describe('account store', () => {
    it('writes mode 0600 and makes the first account active', () => {
      const account = addAccount('a');

      expect(account.active).toBe(true);
      expect(fs.existsSync(STATE_PATH)).toBe(true);

      if (process.platform !== 'win32') {
        expect(fs.statSync(STATE_PATH).mode & 0o777).toBe(0o600);
      }

      const state = readState();
      expect(state.active_account_id).toBe(account.id);
      expect(state.accounts).toHaveLength(1);
      expect(state.accounts[0].label).toBe('a@example.com');
      expect(state.accounts[0].account_uuid).toBe('uuid-a');
      expect(state.accounts[0].organization_uuid).toBe('org-a');
    });

    it('appends a second identity without changing the active account', () => {
      const first = addAccount('a');
      const second = addAccount('b');

      expect(second.active).toBe(false);
      expect(second.id).not.toBe(first.id);
      expect(OAuthManager.accountCount()).toBe(2);
      expect(readState().active_account_id).toBe(first.id);
      expect(OAuthManager.getActiveAccount().id).toBe(first.id);
    });

    it('replaces the same identity in place and clears its limit', () => {
      const first = addAccount('a');

      const state = readState();
      state.accounts[0].limited_until = Date.now() + 600000;
      state.accounts[0].limited_reason = 'rate_limit';
      state.accounts[0].last_limit_at = Date.now();
      OAuthManager.saveState(state);

      const replaced = OAuthManager.addAccount(tokensFor('a-new'), identityFor('a'));

      expect(replaced.id).toBe(first.id);
      expect(replaced.limited).toBe(false);
      expect(OAuthManager.accountCount()).toBe(1);

      const stored = readState().accounts[0];
      expect(stored.access_token).toBe('token-a-new');
      expect(stored.refresh_token).toBe('refresh-a-new');
      expect(stored.limited_until).toBeNull();
      expect(stored.limited_reason).toBeNull();
      expect(stored.last_limit_at).toBeNull();
    });

    it('adopts a migrated account that has no UUIDs but the same email', () => {
      OAuthManager.saveState({
        active_account_id: 'legacy-id',
        accounts: [{
          id: 'legacy-id',
          label: 'Account 1',
          email: 'm@example.com',
          account_uuid: null,
          organization_uuid: null,
          access_token: 'legacy-token',
          refresh_token: 'legacy-refresh',
          expires_at: Date.now() + 3600000,
          limited_until: null,
          limited_reason: null,
          last_limit_at: null,
          created_at: Date.now()
        }]
      });

      const adopted = OAuthManager.addAccount(
        tokensFor('m'),
        { account_uuid: 'uuid-m', organization_uuid: 'org-m', email: 'm@example.com' }
      );

      expect(adopted.id).toBe('legacy-id');
      expect(OAuthManager.accountCount()).toBe(1);

      const stored = readState().accounts[0];
      expect(stored.account_uuid).toBe('uuid-m');
      expect(stored.organization_uuid).toBe('org-m');
      expect(stored.access_token).toBe('token-m');
    });

    it('adopts the sole migrated account on the next login', () => {
      fs.mkdirSync(TEST_DIR, { recursive: true });
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({
        access_token: 'legacy-access',
        refresh_token: 'legacy-refresh',
        expires_at: Date.now() + 3600000
      }));
      const migrated = OAuthManager.loadState().accounts[0];
      expect(migrated.account_uuid).toBeNull();

      const adopted = OAuthManager.addAccount(tokensFor('me'), identityFor('me'));

      expect(adopted.id).toBe(migrated.id);
      expect(OAuthManager.accountCount()).toBe(1);

      const stored = readState().accounts[0];
      expect(stored.access_token).toBe('token-me');
      expect(stored.refresh_token).toBe('refresh-me');
      expect(stored.account_uuid).toBe('uuid-me');
      expect(stored.label).toBe('me@example.com');
    });

    it('keeps the stored refresh token when a login omits it', () => {
      addAccount('a');

      OAuthManager.addAccount(
        { access_token: 'token-a-2', expires_at: Date.now() + 3600000 },
        identityFor('a')
      );

      const stored = readState().accounts[0];
      expect(stored.access_token).toBe('token-a-2');
      expect(stored.refresh_token).toBe('refresh-a');
    });

    it('migrates a legacy tokens.json once and deletes it', () => {
      fs.mkdirSync(TEST_DIR, { recursive: true });
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({
        access_token: 'legacy-access',
        refresh_token: 'legacy-refresh',
        expires_at: 1790000000000
      }));

      const state = OAuthManager.loadState();

      expect(state.accounts).toHaveLength(1);
      expect(state.active_account_id).toBe(state.accounts[0].id);
      expect(state.accounts[0]).toMatchObject({
        label: 'Account 1',
        email: null,
        account_uuid: null,
        organization_uuid: null,
        access_token: 'legacy-access',
        refresh_token: 'legacy-refresh',
        expires_at: 1790000000000
      });
      expect(fs.existsSync(STATE_PATH)).toBe(true);
      expect(fs.existsSync(TOKEN_PATH)).toBe(false);
    });

    it('returns an empty store for an unparseable accounts.json', () => {
      fs.mkdirSync(TEST_DIR, { recursive: true });
      fs.writeFileSync(STATE_PATH, 'not json');

      expect(OAuthManager.loadState()).toEqual({ active_account_id: null, accounts: [] });
      expect(OAuthManager.isAuthenticated()).toBe(false);
    });
  });

  describe('sticky active account', () => {
    it('moves only on a 429 and never moves back when a limit expires', () => {
      const a = addAccount('a');
      const b = addAccount('b');
      const c = addAccount('c');

      expect(OAuthManager.getActiveAccount().id).toBe(a.id);

      // A limits: failover walks forward to B.
      expect(OAuthManager.markAccountLimited(a.id).id).toBe(b.id);
      expect(readState().active_account_id).toBe(b.id);

      // A's limit resets. B is healthy, so traffic stays on B.
      const state = readState();
      state.accounts[0].limited_until = Date.now() - 1000;
      OAuthManager.saveState(state);

      expect(OAuthManager.getActiveAccount().id).toBe(b.id);
      expect(OAuthManager.getStatus().accounts[0].limited).toBe(false);

      expect(OAuthManager.markAccountLimited(b.id).id).toBe(c.id);
      // C limits: A is re-eligible again because its limit expired.
      expect(OAuthManager.markAccountLimited(c.id).id).toBe(a.id);
    });

    it('reports all limited, the earliest reset, and no usable account', () => {
      const a = addAccount('a');
      const b = addAccount('b');

      const resetA = Date.now() + 60000;
      const resetB = Date.now() + 120000;

      expect(OAuthManager.markAccountLimited(a.id, { resetAtMs: resetA }).id).toBe(b.id);
      expect(OAuthManager.markAccountLimited(b.id, { resetAtMs: resetB })).toBeNull();

      expect(OAuthManager.getActiveAccount()).toBeNull();
      expect(OAuthManager.getStatus().all_limited).toBe(true);
      expect(OAuthManager.getEarliestResetMs()).toBe(resetA);
    });

    it('does not move the pointer past the current account for a stale 429', () => {
      const a = addAccount('a');
      const b = addAccount('b');
      addAccount('c');

      OAuthManager.markAccountLimited(a.id);
      expect(readState().active_account_id).toBe(b.id);

      // A second 429 for the already-superseded account A must keep B active.
      expect(OAuthManager.markAccountLimited(a.id).id).toBe(b.id);
      expect(readState().active_account_id).toBe(b.id);
    });
  });

  describe('manual account management', () => {
    it('skips a disabled account during failover until activated', () => {
      const a = addAccount('a');
      const b = addAccount('b');

      OAuthManager.disableAccount(a.id);
      expect(OAuthManager.getActiveAccount().id).toBe(b.id);

      // A limit that has expired makes A eligible again, but not while it is
      // disabled by hand.
      const state = readState();
      state.accounts[0].limited_until = Date.now() - 1000;
      OAuthManager.saveState(state);
      expect(OAuthManager.getActiveAccount().id).toBe(b.id);

      OAuthManager.disableAccount(b.id);
      expect(OAuthManager.getActiveAccount()).toBeNull();
      expect(OAuthManager.getStatus().all_disabled).toBe(true);
    });

    it('disabling the active account advances to the next usable account and persists', () => {
      const a = addAccount('a');
      const b = addAccount('b');
      expect(readState().active_account_id).toBe(a.id);

      const status = OAuthManager.disableAccount(a.id);

      expect(status.active_account_id).toBe(b.id);
      expect(status.accounts.find(x => x.id === a.id).disabled).toBe(true);

      const stored = readState();
      expect(stored.active_account_id).toBe(b.id);
      expect(stored.accounts.find(x => x.id === a.id).disabled).toBe(true);
    });

    it('activating an account clears disabled and makes it active', () => {
      const a = addAccount('a');
      const b = addAccount('b');
      OAuthManager.disableAccount(a.id);
      expect(readState().active_account_id).toBe(b.id);

      const status = OAuthManager.activateAccount(a.id);

      expect(status.active_account_id).toBe(a.id);
      expect(status.accounts.find(x => x.id === a.id)).toMatchObject({
        active: true,
        disabled: false
      });

      const stored = readState();
      expect(stored.active_account_id).toBe(a.id);
      expect(stored.accounts.find(x => x.id === a.id).disabled).toBe(false);
    });

    it('deleting a non-active account keeps the active account', () => {
      const a = addAccount('a');
      const b = addAccount('b');
      const c = addAccount('c');

      const status = OAuthManager.deleteAccount(b.id);

      expect(status.accounts).toHaveLength(2);
      expect(status.active_account_id).toBe(a.id);
      expect(status.accounts.some(x => x.id === b.id)).toBe(false);
      expect(readState().accounts.map(x => x.id)).toEqual([a.id, c.id]);
    });

    it('deleting the active account advances or clears the pointer', () => {
      const a = addAccount('a');
      const b = addAccount('b');

      expect(OAuthManager.deleteAccount(a.id).active_account_id).toBe(b.id);

      const status = OAuthManager.deleteAccount(b.id);
      expect(status.accounts).toEqual([]);
      expect(status.active_account_id).toBeNull();
      expect(OAuthManager.isAuthenticated()).toBe(false);
    });

    it('returns null and writes nothing for unknown ids', () => {
      addAccount('a');
      const before = fs.readFileSync(STATE_PATH);

      expect(OAuthManager.disableAccount('nope')).toBeNull();
      expect(OAuthManager.activateAccount('nope')).toBeNull();
      expect(OAuthManager.deleteAccount('nope')).toBeNull();

      expect(fs.readFileSync(STATE_PATH).equals(before)).toBe(true);
    });

    it('reports disabled and all_disabled in sanitized status', () => {
      const a = addAccount('a');
      OAuthManager.disableAccount(a.id);

      const status = OAuthManager.getStatus();
      expect(status.all_disabled).toBe(true);
      expect(status.accounts[0]).toMatchObject({ id: a.id, disabled: true, active: false });
      expect(JSON.stringify(status.accounts)).not.toContain('token-a');
      expect(JSON.stringify(status.accounts)).not.toContain('refresh-a');
    });

    it('keeps an account disabled across a re-login', () => {
      const a = addAccount('a');
      OAuthManager.disableAccount(a.id);
      expect(readState().active_account_id).toBeNull();

      const tokens = tokensFor('a');
      tokens.access_token = 'token-a-new';
      tokens.refresh_token = 'refresh-a-new';
      const relogged = OAuthManager.addAccount(tokens, identityFor('a'));

      expect(relogged).toMatchObject({ id: a.id, disabled: true, active: false });
      expect(OAuthManager.getStatus().active_account_id).toBeNull();

      const stored = readState().accounts.find(x => x.id === a.id);
      expect(stored.disabled).toBe(true);
      expect(stored.access_token).toBe('token-a-new');
    });

    it('treats a legacy account with no disabled field as enabled', () => {
      fs.mkdirSync(TEST_DIR, { recursive: true });
      fs.writeFileSync(STATE_PATH, JSON.stringify({
        active_account_id: 'legacy',
        accounts: [{
          id: 'legacy',
          label: 'legacy@example.com',
          email: 'legacy@example.com',
          account_uuid: 'uuid-legacy',
          organization_uuid: 'org-legacy',
          access_token: 'token-legacy',
          refresh_token: 'refresh-legacy',
          expires_at: Date.now() + 3600000,
          limited_until: null,
          limited_reason: null,
          last_limit_at: null,
          created_at: 1
        }]
      }, null, 2), { mode: 0o600 });

      expect(OAuthManager.getActiveAccount().id).toBe('legacy');

      const status = OAuthManager.getStatus();
      expect(status.all_disabled).toBe(false);
      expect(status.accounts[0]).toMatchObject({ id: 'legacy', disabled: false, active: true });
    });

    it('activating a limited account switches the pointer but selection skips it', () => {
      const a = addAccount('a');
      const b = addAccount('b');
      addAccount('c');
      OAuthManager.markAccountLimited(a.id, { resetAtMs: Date.now() + 60000 });
      expect(readState().active_account_id).toBe(b.id);

      const status = OAuthManager.activateAccount(a.id);

      expect(status.active_account_id).toBe(a.id);
      expect(status.accounts.find(x => x.id === a.id)).toMatchObject({ active: true, limited: true });

      // Activation does not clear the limit, so the next selection advances.
      expect(OAuthManager.getActiveAccount().id).toBe(b.id);
      expect(readState().active_account_id).toBe(b.id);
    });
  });

  describe('markAccountLimited', () => {
    it('uses an explicit future reset time', () => {
      const a = addAccount('a');
      addAccount('b');
      const resetAt = Date.now() + 900000;

      OAuthManager.markAccountLimited(a.id, { resetAtMs: resetAt });

      expect(readState().accounts[0].limited_until).toBe(resetAt);
      expect(readState().accounts[0].limited_reason).toBe('rate_limit');
    });

    it('falls back to a five minute cooldown without a reset header', () => {
      const a = addAccount('a');
      addAccount('b');
      const before = Date.now();

      OAuthManager.markAccountLimited(a.id);

      const limitedUntil = readState().accounts[0].limited_until;
      expect(limitedUntil).toBeGreaterThanOrEqual(before + 300000);
      expect(limitedUntil).toBeLessThanOrEqual(before + 301000);
    });

    it('ignores a reset time that is already in the past', () => {
      const a = addAccount('a');
      addAccount('b');
      const before = Date.now();

      OAuthManager.markAccountLimited(a.id, { resetAtMs: before - 60000 });

      expect(readState().accounts[0].limited_until).toBeGreaterThanOrEqual(before + 300000);
    });

    it('caps a reset header at one week', () => {
      const a = addAccount('a');
      addAccount('b');
      const before = Date.now();
      const weekMs = 7 * 24 * 60 * 60 * 1000;

      OAuthManager.markAccountLimited(a.id, { resetAtMs: before + 30 * 24 * 60 * 60 * 1000 });

      const limitedUntil = readState().accounts[0].limited_until;
      expect(limitedUntil).toBeGreaterThanOrEqual(before + weekMs);
      expect(limitedUntil).toBeLessThanOrEqual(before + weekMs + 1000);
    });

    it('returns null when the only account is limited', () => {
      const a = addAccount('a');

      expect(OAuthManager.markAccountLimited(a.id)).toBeNull();
      expect(OAuthManager.accountCount()).toBe(1);
    });

    it('stores the 5-hour window end the 429 carried', () => {
      const a = addAccount('a');
      addAccount('b');
      const resetAt = Date.now() + 900000;
      const fiveHourAt = Date.now() + 3600000;

      OAuthManager.markAccountLimited(a.id, { resetAtMs: resetAt, fiveHourResetAtMs: fiveHourAt });

      const stored = readState().accounts[0];
      expect(stored.limited_until).toBe(resetAt);
      expect(stored.five_hour_reset_at).toBe(fiveHourAt);
    });

    it('leaves the 5-hour window alone when the 429 carried no 5-hour header', () => {
      const a = addAccount('a');
      addAccount('b');

      OAuthManager.markAccountLimited(a.id, { resetAtMs: Date.now() + 900000 });

      expect(readState().accounts[0].five_hour_reset_at).toBeNull();
    });
  });

  describe('five hour reset tracking', () => {
    const patchAccount = (id, patch) => {
      const state = readState();
      Object.assign(state.accounts.find(a => a.id === id), patch);
      OAuthManager.saveState(state);
    };

    const candidateIds = (now) => OAuthManager.getAutoPingCandidates(now).map(a => a.id);

    describe('recordFiveHourReset', () => {
      it('stores a future reset', () => {
        const a = addAccount('a');
        const resetAt = Date.now() + 3600000;

        OAuthManager.recordFiveHourReset(a.id, resetAt);

        expect(readState().accounts[0].five_hour_reset_at).toBe(resetAt);
      });

      it('ignores a reset that is already in the past', () => {
        const a = addAccount('a');

        OAuthManager.recordFiveHourReset(a.id, Date.now() - 60000);

        expect(readState().accounts[0].five_hour_reset_at).toBeNull();
      });

      it('ignores junk values without throwing', () => {
        const a = addAccount('a');

        expect(() => {
          OAuthManager.recordFiveHourReset(a.id, null);
          OAuthManager.recordFiveHourReset(a.id, NaN);
          OAuthManager.recordFiveHourReset(a.id, 'soon');
          OAuthManager.recordFiveHourReset('missing-account', Date.now() + 60000);
        }).not.toThrow();

        expect(readState().accounts[0].five_hour_reset_at).toBeNull();
      });

      it('keeps the later of two resets', () => {
        const a = addAccount('a');
        const later = Date.now() + 3600000;

        OAuthManager.recordFiveHourReset(a.id, later);
        OAuthManager.recordFiveHourReset(a.id, later - 600000);
        expect(readState().accounts[0].five_hour_reset_at).toBe(later);

        OAuthManager.recordFiveHourReset(a.id, later + 600000);
        expect(readState().accounts[0].five_hour_reset_at).toBe(later + 600000);
      });

      it('caps a reset at six hours out', () => {
        const a = addAccount('a');
        const before = Date.now();
        const sixHours = 6 * 60 * 60 * 1000;

        OAuthManager.recordFiveHourReset(a.id, before + 30 * 24 * 60 * 60 * 1000);

        const stored = readState().accounts[0].five_hour_reset_at;
        expect(stored).toBeGreaterThanOrEqual(before + sixHours);
        expect(stored).toBeLessThanOrEqual(before + sixHours + 1000);
      });
    });

    describe('recordAutoPingResult', () => {
      it('stores the header reset and the ping time', () => {
        const a = addAccount('a');
        const resetAt = Date.now() + 3600000;

        OAuthManager.recordAutoPingResult(a.id, resetAt);

        const stored = readState().accounts[0];
        expect(stored.five_hour_reset_at).toBe(resetAt);
        expect(stored.auto_ping_last_at).toBeGreaterThan(Date.now() - 5000);
      });

      it('falls back to five hours when the response named no reset', () => {
        const a = addAccount('a');
        const before = Date.now();

        OAuthManager.recordAutoPingResult(a.id, null);

        const stored = readState().accounts[0].five_hour_reset_at;
        expect(stored).toBeGreaterThanOrEqual(before + (5 * 60 * 60 * 1000));
        expect(stored).toBeLessThanOrEqual(before + (5 * 60 * 60 * 1000) + 1000);
      });
    });

    describe('getAutoPingCandidates', () => {
      it('counts a new account with no timestamps as due', () => {
        const a = addAccount('a');

        expect(candidateIds()).toEqual([a.id]);
      });

      it('counts an account whose 5-hour reset has passed', () => {
        const a = addAccount('a');
        const now = Date.now();
        patchAccount(a.id, { five_hour_reset_at: now - 60000 });

        expect(candidateIds(now)).toEqual([a.id]);
      });

      it('leaves an account whose 5-hour reset is a minute away alone', () => {
        const a = addAccount('a');
        const now = Date.now();
        patchAccount(a.id, { five_hour_reset_at: now + 60000 });

        expect(candidateIds(now)).toEqual([]);
      });

      it('skips a disabled account', () => {
        const a = addAccount('a');
        const now = Date.now();
        patchAccount(a.id, { disabled: true, five_hour_reset_at: now - 60000 });

        expect(candidateIds(now)).toEqual([]);
      });

      it('skips an account still serving a longer rate limit', () => {
        const a = addAccount('a');
        const now = Date.now();
        patchAccount(a.id, {
          limited_until: now + 86400000,
          five_hour_reset_at: now - 60000
        });

        expect(candidateIds(now)).toEqual([]);
      });

      it('skips an account with no usable token pair', () => {
        const a = addAccount('a');
        const now = Date.now();
        patchAccount(a.id, { five_hour_reset_at: now - 60000, refresh_token: null });

        expect(candidateIds(now)).toEqual([]);
      });

      it('uses a future 5-hour reset over a stale past rate limit', () => {
        const a = addAccount('a');
        const now = Date.now();
        patchAccount(a.id, {
          limited_until: now - 60000,
          five_hour_reset_at: now + 600000
        });

        expect(candidateIds(now)).toEqual([]);
      });

      it('uses limited_until as the target when no 5-hour reset is known', () => {
        const a = addAccount('a');
        const now = Date.now();
        // Five seconds past the limit end, still inside the grace window: due
        // only if the limit end is the target rather than "no window known".
        patchAccount(a.id, { limited_until: now - 5000 });

        expect(candidateIds(now)).toEqual([]);
        expect(candidateIds(now + 10000)).toEqual([a.id]);
      });

      it('uses the last ping plus five hours when no reset is known', () => {
        const a = addAccount('a');
        const now = Date.now();
        patchAccount(a.id, { auto_ping_last_at: now - (4 * 60 * 60 * 1000) });

        expect(candidateIds(now)).toEqual([]);
        expect(candidateIds(now + (1 * 60 * 60 * 1000) + 10000)).toEqual([a.id]);
      });
    });
  });

  describe('getStatus', () => {
    it('exposes sanitized accounts only', () => {
      const a = addAccount('a');
      addAccount('b');
      OAuthManager.markAccountLimited(a.id, { resetAtMs: Date.now() + 60000 });

      const status = OAuthManager.getStatus();
      const serialized = JSON.stringify(status.accounts);

      expect(serialized).not.toContain('access_token');
      expect(serialized).not.toContain('refresh_token');
      expect(serialized).not.toContain('token-a');
      expect(status.accounts).toHaveLength(2);
      expect(status.accounts[1]).toMatchObject({
        id: expect.any(String),
        label: 'b@example.com',
        email: 'b@example.com',
        active: true,
        limited: false,
        limited_until: null
      });
      expect(status.authenticated).toBe(true);
      expect(status.active_account_id).toBe(status.accounts[1].id);
    });
  });

  describe('refresh', () => {
    it('refreshes only the requested account', async () => {
      const a = addAccount('a', identityFor('a'));
      addAccount('b', identityFor('b'));

      // Make A expired and B still valid.
      const state = readState();
      state.accounts[0].expires_at = Date.now() - 1000;
      OAuthManager.saveState(state);

      nock('https://console.anthropic.com')
        .post('/v1/oauth/token', (body) => body.refresh_token === 'refresh-a')
        .reply(200, { access_token: 'new-a', refresh_token: 'rotated-a', expires_in: 3600 });

      await expect(OAuthManager.getValidAccessToken(a.id)).resolves.toBe('new-a');

      const stored = readState().accounts;
      expect(stored[0].access_token).toBe('new-a');
      expect(stored[0].refresh_token).toBe('rotated-a');
      expect(stored[1].access_token).toBe('token-b');
      expect(stored[1].refresh_token).toBe('refresh-b');
    });

    it('makes one request for concurrent refreshes of the same account', async () => {
      const a = addAccount('a');
      nock('https://console.anthropic.com')
        .post('/v1/oauth/token')
        .once()
        .reply(200, { access_token: 'new-a', refresh_token: 'rotated-a', expires_in: 3600 });

      const [first, second] = await Promise.all([
        OAuthManager.refreshAccessToken(a.id),
        OAuthManager.refreshAccessToken(a.id)
      ]);

      expect(first.access_token).toBe('new-a');
      expect(second.access_token).toBe('new-a');
      expect(nock.pendingMocks()).toEqual([]);
    });

    it('recovers after a failed refresh once the credential is repaired', async () => {
      const a = addAccount('a');
      let state = readState();
      state.accounts[0].refresh_token = null;
      OAuthManager.saveState(state);

      await expect(OAuthManager.refreshAccessToken(a.id)).rejects.toThrow('No refresh token available');
      // The failure must not stay cached as the account's in-flight refresh.
      expect(OAuthManager.refreshPromises.size).toBe(0);

      state = readState();
      state.accounts[0].refresh_token = 'refresh-repaired';
      OAuthManager.saveState(state);

      nock('https://console.anthropic.com')
        .post('/v1/oauth/token', (body) => body.refresh_token === 'refresh-repaired')
        .reply(200, { access_token: 'new-a', expires_in: 3600 });

      await expect(OAuthManager.refreshAccessToken(a.id))
        .resolves.toMatchObject({ access_token: 'new-a' });
      expect(readState().accounts[0].access_token).toBe('new-a');
    });

    it('refreshes different accounts in parallel', async () => {
      const a = addAccount('a');
      const b = addAccount('b');

      nock('https://console.anthropic.com')
        .post('/v1/oauth/token', (body) => body.refresh_token === 'refresh-a')
        .reply(200, { access_token: 'new-a', expires_in: 3600 });
      nock('https://console.anthropic.com')
        .post('/v1/oauth/token', (body) => body.refresh_token === 'refresh-b')
        .reply(200, { access_token: 'new-b', expires_in: 3600 });

      const [first, second] = await Promise.all([
        OAuthManager.refreshAccessToken(a.id),
        OAuthManager.refreshAccessToken(b.id)
      ]);

      expect(first.access_token).toBe('new-a');
      expect(second.access_token).toBe('new-b');
      expect(nock.pendingMocks()).toEqual([]);
    });

    it('does not refresh a token that is valid for more than a minute', async () => {
      const a = addAccount('a');

      await expect(OAuthManager.getValidAccessToken(a.id)).resolves.toBe('token-a');
      expect(nock.pendingMocks()).toEqual([]);
    });

    it('treats a missing expires_at as expired', async () => {
      const a = addAccount('a');
      const state = readState();
      delete state.accounts[0].expires_at;
      OAuthManager.saveState(state);

      nock('https://console.anthropic.com')
        .post('/v1/oauth/token')
        .reply(200, { access_token: 'new-a', expires_in: 3600 });

      await expect(OAuthManager.getValidAccessToken(a.id)).resolves.toBe('new-a');
    });

    it('throws for an unknown account', async () => {
      addAccount('a');

      await expect(OAuthManager.getValidAccessToken('nope')).rejects.toThrow('Account not found: nope');
      await expect(OAuthManager.refreshAccessToken('nope')).rejects.toThrow('Account not found: nope');
    });

    it('throws when the account has no refresh token', async () => {
      const a = addAccount('a');
      const state = readState();
      state.accounts[0].refresh_token = null;
      OAuthManager.saveState(state);

      await expect(OAuthManager.refreshAccessToken(a.id)).rejects.toThrow('No refresh token available');
    });
  });

  describe('isAuthenticated', () => {
    it('is false with no accounts', () => {
      expect(OAuthManager.isAuthenticated()).toBe(false);
    });

    it('is true with an account, expired or not', () => {
      const a = addAccount('a');
      expect(OAuthManager.isAuthenticated()).toBe(true);

      const state = readState();
      state.accounts[0].expires_at = Date.now() - 1000;
      OAuthManager.saveState(state);
      expect(OAuthManager.isAuthenticated()).toBe(true);
      expect(a.id).toBeTruthy();
    });

    it('is false when the store holds only tokens without a refresh token', () => {
      OAuthManager.saveState({
        active_account_id: 'x',
        accounts: [{ id: 'x', access_token: 'only-access', refresh_token: null }]
      });

      expect(OAuthManager.isAuthenticated()).toBe(false);
    });
  });

  describe('logout', () => {
    it('removes both files and clears in-flight refreshes', () => {
      addAccount('a');
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({ access_token: 'legacy', refresh_token: 'legacy' }));
      OAuthManager.refreshPromises.set('a', Promise.resolve());

      expect(fs.existsSync(STATE_PATH)).toBe(true);
      expect(fs.existsSync(TOKEN_PATH)).toBe(true);

      OAuthManager.logout();

      expect(fs.existsSync(STATE_PATH)).toBe(false);
      expect(fs.existsSync(TOKEN_PATH)).toBe(false);
      expect(OAuthManager.refreshPromises.size).toBe(0);
    });

    it('does not throw when nothing is stored', () => {
      expect(() => OAuthManager.logout()).not.toThrow();
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('should exchange authorization code for tokens', async () => {
      const mockResponse = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600
      };

      nock('https://console.anthropic.com')
        .post('/v1/oauth/token', {
          grant_type: 'authorization_code',
          code: 'test-auth-code',
          state: 'test-state',
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
          code_verifier: 'test-code-verifier',
          redirect_uri: 'https://console.anthropic.com/oauth/code/callback'
        })
        .reply(200, mockResponse);

      const tokens = await OAuthManager.exchangeCodeForTokens('test-auth-code', 'test-code-verifier', 'test-state');

      expect(tokens).toEqual(mockResponse);
    });

    it('should throw error on failed token exchange', async () => {
      nock('https://console.anthropic.com')
        .post('/v1/oauth/token')
        .reply(400, { error: 'invalid_grant' });

      await expect(
        OAuthManager.exchangeCodeForTokens('invalid-code', 'test-verifier', 'test-state')
      ).rejects.toThrow();
    });
  });
});
