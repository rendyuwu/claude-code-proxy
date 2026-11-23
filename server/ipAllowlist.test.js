const {
  normalizeAddress,
  matchesCidr,
  isAllowed,
  isValidEntry,
  parseAllowlist
} = require('./ipAllowlist');

describe('normalizeAddress', () => {
  it('strips the IPv4-mapped prefix a dual-stack socket adds', () => {
    expect(normalizeAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeAddress('::FFFF:10.8.0.5')).toBe('10.8.0.5');
  });

  it('strips brackets from a bracketed IPv6 literal', () => {
    expect(normalizeAddress('[::1]')).toBe('::1');
  });

  it('returns an empty string for non-strings', () => {
    expect(normalizeAddress(undefined)).toBe('');
    expect(normalizeAddress(null)).toBe('');
    expect(normalizeAddress(42)).toBe('');
  });
});

describe('matchesCidr', () => {
  it('matches a bare address exactly', () => {
    expect(matchesCidr('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(matchesCidr('127.0.0.2', '127.0.0.1')).toBe(false);
  });

  it('matches the VPN range', () => {
    expect(matchesCidr('10.8.0.1', '10.8.0.0/24')).toBe(true);
    expect(matchesCidr('10.8.0.254', '10.8.0.0/24')).toBe(true);
    expect(matchesCidr('10.8.1.1', '10.8.0.0/24')).toBe(false);
    expect(matchesCidr('10.7.255.254', '10.8.0.0/24')).toBe(false);
  });

  it('matches the boundary addresses of a range', () => {
    expect(matchesCidr('10.0.0.0', '10.0.0.0/8')).toBe(true);
    expect(matchesCidr('10.255.255.255', '10.0.0.0/8')).toBe(true);
    expect(matchesCidr('11.0.0.0', '10.0.0.0/8')).toBe(false);
  });

  it('treats /0 as everything and /32 as one host', () => {
    expect(matchesCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(matchesCidr('10.8.0.5', '10.8.0.5/32')).toBe(true);
    expect(matchesCidr('10.8.0.6', '10.8.0.5/32')).toBe(false);
  });

  it('handles loopback and IPv6', () => {
    expect(matchesCidr('::1', '::1')).toBe(true);
    expect(matchesCidr('::1', '::1/128')).toBe(true);
    expect(matchesCidr('::2', '::1/128')).toBe(false);
    expect(matchesCidr('2001:db8::5', '2001:db8::/32')).toBe(true);
    expect(matchesCidr('2001:db9::5', '2001:db8::/32')).toBe(false);
  });

  it('never matches across address families', () => {
    expect(matchesCidr('::1', '127.0.0.1')).toBe(false);
    expect(matchesCidr('127.0.0.1', '::1')).toBe(false);
  });

  it('rejects a malformed range instead of matching everything', () => {
    expect(matchesCidr('127.0.0.1', 'not-an-ip')).toBe(false);
    expect(matchesCidr('127.0.0.1', '127.0.0.1/33')).toBe(false);
    expect(matchesCidr('127.0.0.1', '127.0.0.1/x')).toBe(false);
  });
});

describe('isAllowed', () => {
  it('accepts when any entry matches', () => {
    const allowlist = '127.0.0.1/32,::1/128,10.8.0.0/24';

    expect(isAllowed('127.0.0.1', allowlist)).toBe(true);
    expect(isAllowed('10.8.0.7', allowlist)).toBe(true);
    expect(isAllowed('10.8.1.7', allowlist)).toBe(false);
  });

  it('denies everything when the list is empty', () => {
    expect(isAllowed('127.0.0.1', '')).toBe(false);
    expect(isAllowed('127.0.0.1', [])).toBe(false);
  });

  it('accepts an array as well as a comma-separated string', () => {
    expect(isAllowed('10.8.0.7', ['10.8.0.0/24'])).toBe(true);
  });
});

describe('isValidEntry', () => {
  it('accepts addresses and ranges', () => {
    expect(isValidEntry('127.0.0.1')).toBe(true);
    expect(isValidEntry('10.8.0.0/24')).toBe(true);
    expect(isValidEntry('::1')).toBe(true);
    expect(isValidEntry('2001:db8::/32')).toBe(true);
  });

  it('rejects garbage, bad prefixes and doubled masks', () => {
    expect(isValidEntry('')).toBe(false);
    expect(isValidEntry('999.1.1.1')).toBe(false);
    expect(isValidEntry('10.0.0.0/33')).toBe(false);
    expect(isValidEntry('::1/129')).toBe(false);
    expect(isValidEntry('10.0.0.0/8/8')).toBe(false);
    expect(isValidEntry('10.0.0.0/abc')).toBe(false);
  });
});

describe('parseAllowlist', () => {
  it('splits on commas and whitespace and drops empties', () => {
    expect(parseAllowlist(' 127.0.0.1 , ::1,  , 10.8.0.0/24 '))
      .toEqual(['127.0.0.1', '::1', '10.8.0.0/24']);
  });

  it('returns nothing for an unset value', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist(null)).toEqual([]);
    expect(parseAllowlist('')).toEqual([]);
  });
});
