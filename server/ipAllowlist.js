'use strict';

// IPv4/IPv6 CIDR matching for the unauthenticated /limits endpoint. That route
// exposes per-account usage, so it is restricted to the caller's own machine
// and network rather than left open to anyone who can reach the port.
//
// Node reports IPv4 clients on a dual-stack socket as "::ffff:127.0.0.1", so
// the mapping prefix is stripped before anything is compared.

const { isIPv4, isIPv6 } = require('net');

const IPV4_BITS = 32;

/**
 * @param {string} address bare address, no zone or port
 * @returns {number|null} the address as an unsigned 32-bit integer
 */
const ipv4ToInt = (address) => {
  if (!isIPv4(address)) return null;
  const parts = address.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
};

/**
 * Expand an IPv6 address into its eight 16-bit groups, honouring "::".
 * @param {string} address
 * @returns {number[]|null}
 */
const ipv6Groups = (address) => {
  if (!isIPv6(address)) return null;

  // An embedded IPv4 tail ("::ffff:1.2.3.4") becomes two groups.
  let text = address;
  const tail = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const value = ipv4ToInt(tail[2]);
    if (value === null) return null;
    text = `${tail[1]}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const [head, rest] = text.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const restGroups = rest !== undefined && rest !== '' ? rest.split(':').filter(Boolean) : [];
  if (rest === undefined && headGroups.length !== 8) return null;
  if (headGroups.length + restGroups.length > 8) return null;

  const fill = new Array(8 - headGroups.length - restGroups.length).fill('0');
  return [...headGroups, ...fill, ...restGroups].map(group => parseInt(group, 16));
};

const stripBrackets = (value) => value.replace(/^\[|\]$/g, '');

/**
 * Reduce a client address to a bare IPv4 or IPv6 string.
 * @param {string} raw e.g. "::ffff:127.0.0.1", "[::1]", "127.0.0.1"
 * @returns {string}
 */
const normalizeAddress = (raw) => {
  if (typeof raw !== 'string') return '';
  const value = stripBrackets(raw.trim());
  // A dual-stack socket presents IPv4 peers this way; the mapped form must be
  // compared as the IPv4 address the user actually wrote in the allowlist.
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  return value;
};

/**
 * @param {string} raw client address
 * @param {string} cidr "10.0.0.0/8", "127.0.0.1", "::1/128"
 * @returns {boolean}
 */
const matchesCidr = (raw, cidr) => {
  const address = normalizeAddress(raw);
  if (!address) return false;

  const [networkRaw, prefixRaw] = String(cidr).split('/');
  const network = normalizeAddress(networkRaw);
  if (!network) return false;

  if (isIPv4(network)) {
    if (!isIPv4(address)) return false;
    const prefix = prefixRaw === undefined ? IPV4_BITS : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > IPV4_BITS) return false;
    // A zero mask makes the shift by 32, which JS wraps to a shift by 0.
    if (prefix === 0) return true;
    const mask = (0xffffffff << (IPV4_BITS - prefix)) >>> 0;
    return (ipv4ToInt(address) & mask) === (ipv4ToInt(network) & mask);
  }

  if (isIPv6(network)) {
    if (!isIPv6(address)) return false;
    const prefix = prefixRaw === undefined ? 128 : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;

    const client = ipv6Groups(address);
    const base = ipv6Groups(network);
    if (!client || !base) return false;

    let remaining = prefix;
    for (let index = 0; index < 8 && remaining > 0; index += 1) {
      const bits = Math.min(16, remaining);
      const mask = bits === 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
      if ((client[index] & mask) !== (base[index] & mask)) return false;
      remaining -= bits;
    }
    return true;
  }

  return false;
};

/**
 * Parse an allowlist setting into trimmed entries, dropping empties.
 * @param {string|string[]} value comma/space separated, or an array
 * @returns {string[]}
 */
const parseAllowlist = (value) => {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  return items.map(item => String(item).trim()).filter(Boolean);
};

/**
 * @param {string} raw client address
 * @param {string|string[]} allowlist
 * @returns {boolean}
 */
const isAllowed = (raw, allowlist) => (
  parseAllowlist(allowlist).some(entry => matchesCidr(raw, entry))
);

/**
 * Validate an allowlist entry for the settings UI, so a typo is reported
 * instead of silently granting nobody (or everybody) access.
 * @param {string} entry
 * @returns {boolean}
 */
const isValidEntry = (entry) => {
  const [networkRaw, prefixRaw, ...extra] = String(entry).trim().split('/');
  if (extra.length > 0) return false;
  const network = normalizeAddress(networkRaw);
  if (!isIPv4(network) && !isIPv6(network)) return false;
  if (prefixRaw === undefined) return true;
  if (!/^\d+$/.test(prefixRaw)) return false;
  const prefix = Number(prefixRaw);
  return isIPv4(network) ? prefix <= 32 : prefix <= 128;
};

module.exports = {
  normalizeAddress,
  matchesCidr,
  isAllowed,
  isValidEntry,
  parseAllowlist
};
