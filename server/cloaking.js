const crypto = require('crypto');

// Claude Code 2.1.258 sends a billing header as the first system block and a
// JSON-shaped metadata.user_id alongside it. Both are reproduced here so a
// request carrying a subscription token looks like the client that owns it.
const CLAUDE_CLI_VERSION = '2.1.258';
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

// Claude Code's own tool set. A subscription token whose requests declare
// SillyTavern or LibreChat tool names, and none of these, does not look like the
// client the token belongs to. The client's tools are renamed out of the way and
// these are declared alongside them, marked unavailable so the model leaves them
// alone.
const CLAUDE_TOOL_SUFFIX = '_ide';
const DECOY_DESCRIPTION = 'This tool is currently unavailable.';
const CC_TOOL_NAMES = [
  'Task', 'TaskOutput', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
  'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'AskUserQuestion', 'Skill', 'EnterPlanMode', 'ExitPlanMode'
];

const buildDecoy = (name) => ({
  name,
  description: DECOY_DESCRIPTION,
  input_schema: { type: 'object', properties: {} }
});

// Anthropic rejects a tool name longer than this, so a name that cannot carry
// the suffix is left alone rather than made invalid.
const MAX_TOOL_NAME_LENGTH = 128;

/**
 * Rename the client's tools and declare the Claude Code set alongside them.
 * Mutates the body it is given; processRequestBody already works on a clone.
 * @param {object} body - Claude API request body
 * @returns {Map<string, string>|null} suffixed name -> original name, or null when nothing was renamed
 */
function cloakTools(body) {
  const tools = body?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const toolNameMap = new Map();
  const renamedClientNames = new Set();
  const declarations = [];

  for (const tool of tools) {
    // Server-side tools (web_search_20250305 and the like) carry a `type` and
    // are matched on an exact reserved name; renaming one is rejected outright.
    if (!tool || tool.type || typeof tool.name !== 'string') {
      declarations.push(tool);
      continue;
    }

    const suffixed = `${tool.name}${CLAUDE_TOOL_SUFFIX}`;
    if (suffixed.length > MAX_TOOL_NAME_LENGTH) {
      declarations.push(tool);
      continue;
    }

    toolNameMap.set(suffixed, tool.name);
    renamedClientNames.add(tool.name);
    declarations.push({ ...tool, name: suffixed });
  }

  // A client tool that kept its own name (too long to suffix) already occupies
  // that slot, and two tools cannot share a name.
  const taken = new Set(declarations.map(tool => tool?.name).filter(Boolean));
  const decoys = CC_TOOL_NAMES.filter(name => !taken.has(name)).map(buildDecoy);

  // A breakpoint marks the end of the cached prefix, so decoys appended after
  // the client's trailing one would be re-billed on every request. Hand the
  // breakpoint to the last decoy instead; the count is unchanged and the
  // client's own tools stay inside the prefix either way.
  const lastClient = declarations[declarations.length - 1];
  const lastDecoy = decoys[decoys.length - 1];
  if (lastDecoy && lastClient?.cache_control) {
    lastDecoy.cache_control = lastClient.cache_control;
    delete lastClient.cache_control;
  }

  body.tools = [...declarations, ...decoys];

  // A forced tool_choice has to follow the tool it names, or Anthropic answers
  // "Tool '<name>' not found in provided tools".
  if (body.tool_choice?.type === 'tool' && renamedClientNames.has(body.tool_choice.name)) {
    body.tool_choice = { ...body.tool_choice, name: `${body.tool_choice.name}${CLAUDE_TOOL_SUFFIX}` };
  }

  if (toolNameMap.size === 0) return null;

  // Past turns declared the same tools, so their tool_use blocks have to use the
  // renamed form as well. tool_result refers back by tool_use_id, not by name.
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!Array.isArray(message?.content)) continue;
      for (const block of message.content) {
        if (block?.type === 'tool_use' && renamedClientNames.has(block.name)) {
          block.name = `${block.name}${CLAUDE_TOOL_SUFFIX}`;
        }
      }
    }
  }

  return toolNameMap;
}

/**
 * Undo cloakTools on the names in a non-streaming response body.
 * @param {object} body - parsed Claude API response
 * @param {Map<string, string>|null} toolNameMap
 * @returns {object} the same body
 */
function decloakToolNames(body, toolNameMap) {
  if (!toolNameMap?.size || !Array.isArray(body?.content)) return body;

  for (const block of body.content) {
    if (block?.type === 'tool_use' && toolNameMap.has(block.name)) {
      block.name = toolNameMap.get(block.name);
    }
  }

  return body;
}

module.exports = {
  applyCloaking,
  buildBillingHeader,
  buildUserId,
  cloakTools,
  conversationSeed,
  decloakToolNames,
  deriveUuid,
  isOAuthToken,
  BILLING_PREFIX,
  CLAUDE_CLI_VERSION,
  CLAUDE_TOOL_SUFFIX,
  CC_TOOL_NAMES,
  MAX_TOOL_NAME_LENGTH
};
