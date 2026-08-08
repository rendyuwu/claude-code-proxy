const crypto = require('crypto');

// Claude Code 2.1.92 sends a billing header as the first system block and a
// JSON-shaped metadata.user_id alongside it. Both are reproduced here so a
// request carrying a subscription token looks like the client that owns it.
const CLAUDE_CLI_VERSION = '2.1.92';
const CC_ENTRYPOINT = 'sdk-cli';

const BILLING_PREFIX = 'x-anthropic-billing-header:';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Only OAuth (subscription) tokens get this treatment. A plain API key is
// billed as API usage and never carries a CLI identity.
function isOAuthToken(token) {
  return typeof token === 'string' && token.includes('sk-ant-oat');
}

// UUID-v4-shaped, but derived rather than random: the same account must produce
// the same ids on every request and across restarts.
function deriveUuid(seed) {
  const h = sha256(seed);
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Every field is derived from the token, never randomized. A value that changes
// between requests sits at the head of the prompt and therefore invalidates the
// cached prefix on every single turn — the whole conversation gets re-billed as
// a cache write. Anthropic does not validate these fields (other clients send a
// randomized build hash and are accepted), so determinism costs nothing and
// keeps prompt caching intact.
function buildBillingHeader(token) {
  const build = sha256(`build:${token}`).slice(0, 3);
  const cch = sha256(`cch:${token}`).slice(0, 5);
  return `${BILLING_PREFIX} cc_version=${CLAUDE_CLI_VERSION}.${build}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${cch};`;
}

// device_id and account_uuid identify the installation, so they follow the
// token. session_id identifies one conversation: it has to stay the same across
// the turns of a chat (a new id every turn would look like thousands of
// one-message sessions) and differ between chats.
function buildUserId(token, conversationSeed) {
  return JSON.stringify({
    device_id: sha256(`device:${token}`),
    account_uuid: deriveUuid(`account:${token}`),
    session_id: deriveUuid(`session:${token}:${conversationSeed}`)
  });
}

// The opening of a conversation is what stays constant as it grows: later turns
// are appended, so seeding from the first turn keeps one chat on one session id.
function conversationSeed(body) {
  const firstMessage = Array.isArray(body?.messages) ? body.messages[0] : null;
  return JSON.stringify({
    model: body?.model ?? null,
    system: body?.system ?? null,
    first: firstMessage ?? null
  });
}

function hasBillingBlock(system) {
  return Array.isArray(system) && typeof system[0]?.text === 'string'
    && system[0].text.startsWith(BILLING_PREFIX);
}

/**
 * Prepend the billing header block and fill in metadata.user_id.
 * Mutates the body it is given; processRequestBody already works on a clone.
 * @param {object} body - Claude API request body, system already normalized to an array
 * @param {string} token - Authorization header value for this request
 * @returns {object} the same body
 */
function applyCloaking(body, token) {
  if (!body || !isOAuthToken(token)) return body;

  const seed = conversationSeed(body);

  if (!hasBillingBlock(body.system)) {
    const billingBlock = { type: 'text', text: buildBillingHeader(token) };
    body.system = Array.isArray(body.system) ? [billingBlock, ...body.system] : [billingBlock];
  }

  // A client that sends its own user_id knows something we do not; leave it.
  if (!body.metadata?.user_id) {
    body.metadata = { ...body.metadata, user_id: buildUserId(token, seed) };
  }

  return body;
}

module.exports = {
  applyCloaking,
  buildBillingHeader,
  buildUserId,
  conversationSeed,
  deriveUuid,
  isOAuthToken,
  BILLING_PREFIX,
  CLAUDE_CLI_VERSION
};
