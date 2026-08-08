const {
  applyCloaking,
  buildBillingHeader,
  buildUserId,
  cloakTools,
  conversationSeed,
  decloakToolNames,
  isOAuthToken,
  BILLING_PREFIX,
  CC_TOOL_NAMES,
  MAX_TOOL_NAME_LENGTH
} = require('./cloaking');

const OAT = 'Bearer sk-ant-oat01-EXAMPLE-TOKEN';
const OTHER_OAT = 'Bearer sk-ant-oat01-DIFFERENT-TOKEN';

const bodyWith = (overrides = {}) => ({
  model: 'claude-sonnet-5',
  system: [{ type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' }],
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides
});

describe('isOAuthToken', () => {
  it('accepts a subscription token and rejects anything else', () => {
    expect(isOAuthToken(OAT)).toBe(true);
    expect(isOAuthToken('Bearer sk-ant-api03-KEY')).toBe(false);
    expect(isOAuthToken(null)).toBe(false);
    expect(isOAuthToken(undefined)).toBe(false);
  });
});

describe('billing header', () => {
  it('matches the shape the CLI sends', () => {
    expect(buildBillingHeader(OAT))
      .toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.92\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/);
  });

  it('is byte-identical across calls so it cannot invalidate the cached prefix', () => {
    expect(buildBillingHeader(OAT)).toBe(buildBillingHeader(OAT));
  });

  it('differs between accounts', () => {
    expect(buildBillingHeader(OAT)).not.toBe(buildBillingHeader(OTHER_OAT));
  });
});

describe('metadata user id', () => {
  const parse = (token, seed) => JSON.parse(buildUserId(token, seed));

  it('has the device/account/session shape the CLI sends', () => {
    const userId = parse(OAT, 'seed');

    expect(userId.device_id).toMatch(/^[0-9a-f]{64}$/);
    expect(userId.account_uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(userId.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('keeps device and account stable for one token and separate between tokens', () => {
    expect(parse(OAT, 'a').device_id).toBe(parse(OAT, 'b').device_id);
    expect(parse(OAT, 'a').account_uuid).toBe(parse(OAT, 'b').account_uuid);
    expect(parse(OAT, 'a').device_id).not.toBe(parse(OTHER_OAT, 'a').device_id);
  });

  it('never leaks the token it was derived from', () => {
    expect(buildUserId(OAT, 'seed')).not.toContain('sk-ant-oat01-EXAMPLE-TOKEN');
  });

  it('gives one session id per conversation, not per turn', () => {
    const turn1 = bodyWith();
    const turn2 = bodyWith({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'and again' }
      ]
    });
    const otherChat = bodyWith({ messages: [{ role: 'user', content: 'different opening' }] });

    expect(parse(OAT, conversationSeed(turn2)).session_id)
      .toBe(parse(OAT, conversationSeed(turn1)).session_id);
    expect(parse(OAT, conversationSeed(otherChat)).session_id)
      .not.toBe(parse(OAT, conversationSeed(turn1)).session_id);
  });
});

describe('applyCloaking', () => {
  it('puts the billing block ahead of the Claude Code sentence', () => {
    const body = applyCloaking(bodyWith(), OAT);

    expect(body.system[0].text.startsWith(BILLING_PREFIX)).toBe(true);
    expect(body.system[1].text).toMatch(/^You are Claude Code/);
  });

  it('does nothing at all without a subscription token', () => {
    const body = applyCloaking(bodyWith(), 'Bearer sk-ant-api03-KEY');

    expect(body.system).toHaveLength(1);
    expect(body.metadata).toBeUndefined();
  });

  it('injects once even if it runs twice on the same body', () => {
    const body = applyCloaking(applyCloaking(bodyWith(), OAT), OAT);

    expect(body.system.filter(block => block.text.startsWith(BILLING_PREFIX))).toHaveLength(1);
  });

  it('leaves a user_id the client supplied', () => {
    const body = applyCloaking(bodyWith({ metadata: { user_id: 'mine' } }), OAT);

    expect(body.metadata.user_id).toBe('mine');
  });

  it('keeps other metadata fields the client sent', () => {
    const body = applyCloaking(bodyWith({ metadata: { something_else: 1 } }), OAT);

    expect(body.metadata.something_else).toBe(1);
    expect(body.metadata.user_id).toContain('device_id');
  });

  it('never touches a cache_control breakpoint the client set', () => {
    const body = applyCloaking(bodyWith({
      system: [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral', ttl: '1h' } }]
    }), OAT);

    expect(body.system[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(body.system[0].cache_control).toBeUndefined();
  });
});

describe('cloakTools', () => {
  const tool = (name, extra = {}) => ({ name, description: `does ${name}`, input_schema: { type: 'object' }, ...extra });

  it('renames the client tools and keeps everything else about them', () => {
    const body = { tools: [tool('search_web')] };
    const map = cloakTools(body);

    expect(body.tools[0]).toMatchObject({
      name: 'search_web_ide',
      description: 'does search_web',
      input_schema: { type: 'object' }
    });
    expect(map.get('search_web_ide')).toBe('search_web');
  });

  it('declares the Claude Code tool set alongside them, marked unavailable', () => {
    const body = { tools: [tool('search_web')] };
    cloakTools(body);

    const decoys = body.tools.slice(1);
    expect(decoys.map(t => t.name)).toEqual(CC_TOOL_NAMES);
    expect(decoys.every(t => t.description === 'This tool is currently unavailable.')).toBe(true);
  });

  it('leaves a server-side tool alone, since its name is reserved', () => {
    const body = { tools: [{ type: 'web_search_20250305', name: 'web_search' }, tool('mine')] };
    const map = cloakTools(body);

    expect(body.tools[0]).toEqual({ type: 'web_search_20250305', name: 'web_search' });
    expect(map.has('web_search_ide')).toBe(false);
    expect(map.get('mine_ide')).toBe('mine');
  });

  it('leaves a name that cannot carry the suffix, rather than sending an invalid one', () => {
    const long = 'm'.repeat(MAX_TOOL_NAME_LENGTH - 3);
    const body = { tools: [tool(long)] };
    const map = cloakTools(body);

    expect(body.tools[0].name).toBe(long);
    expect(map).toBeNull();
  });

  it('does not declare a decoy whose name a client tool already holds', () => {
    const kept = `Read${'x'.repeat(MAX_TOOL_NAME_LENGTH)}`.slice(0, MAX_TOOL_NAME_LENGTH);
    const body = { tools: [tool('Read'), tool(kept)] };
    cloakTools(body);

    const names = body.tools.map(t => t.name);
    expect(names.filter(name => name === kept)).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
    // "Read" moved out of the way, so the decoy can still take that name.
    expect(names).toContain('Read_ide');
    expect(names).toContain('Read');
  });

  it('points a forced tool_choice at the renamed tool', () => {
    const body = { tools: [tool('mine')], tool_choice: { type: 'tool', name: 'mine' } };
    cloakTools(body);

    expect(body.tool_choice).toEqual({ type: 'tool', name: 'mine_ide' });
  });

  it('leaves tool_choice alone when it names nothing we renamed', () => {
    const auto = { tools: [tool('mine')], tool_choice: { type: 'auto' } };
    const decoy = { tools: [tool('mine')], tool_choice: { type: 'tool', name: 'Bash' } };

    cloakTools(auto);
    cloakTools(decoy);

    expect(auto.tool_choice).toEqual({ type: 'auto' });
    expect(decoy.tool_choice).toEqual({ type: 'tool', name: 'Bash' });
  });

  it('renames the tool_use blocks already in the history', () => {
    const body = {
      tools: [tool('mine')],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'mine', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] }
      ]
    };
    cloakTools(body);

    expect(body.messages[0].content[0].name).toBe('mine_ide');
    // tool_result refers back by id, so it is untouched.
    expect(body.messages[1].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' });
  });

  it('leaves a history tool_use for a tool that is no longer declared', () => {
    const body = {
      tools: [tool('mine')],
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'gone', input: {} }] }]
    };
    cloakTools(body);

    expect(body.messages[0].content[0].name).toBe('gone');
  });

  it('hands the trailing tool breakpoint to the last decoy so the decoys stay cached', () => {
    const body = { tools: [tool('mine', { cache_control: { type: 'ephemeral', ttl: '1h' } })] };
    cloakTools(body);

    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[body.tools.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(body.tools.filter(t => t.cache_control)).toHaveLength(1);
  });

  it('does not invent a tool breakpoint when the client set none', () => {
    const body = { tools: [tool('mine')] };
    cloakTools(body);

    expect(body.tools.every(t => t.cache_control === undefined)).toBe(true);
  });

  it('does nothing without tools', () => {
    expect(cloakTools({ messages: [] })).toBeNull();
    expect(cloakTools({ tools: [] })).toBeNull();
    expect(cloakTools(null)).toBeNull();
  });

  it('is stable, so the 401 retry sends the same names', () => {
    const build = () => ({ tools: [tool('mine')], tool_choice: { type: 'tool', name: 'mine' } });
    const first = build();
    const second = build();

    cloakTools(first);
    cloakTools(second);

    expect(second).toEqual(first);
  });

  it('does not let the decoys of one request leak into the next', () => {
    const first = { tools: [tool('mine', { cache_control: { type: 'ephemeral' } })] };
    cloakTools(first);
    const second = { tools: [tool('other')] };
    cloakTools(second);

    expect(second.tools[second.tools.length - 1].cache_control).toBeUndefined();
  });
});

describe('decloakToolNames', () => {
  it('puts the client name back', () => {
    const body = { content: [{ type: 'tool_use', name: 'mine_ide', input: {} }] };
    decloakToolNames(body, new Map([['mine_ide', 'mine']]));

    expect(body.content[0].name).toBe('mine');
  });

  it('leaves a decoy name it cannot map', () => {
    const body = { content: [{ type: 'tool_use', name: 'Bash', input: {} }] };
    decloakToolNames(body, new Map([['mine_ide', 'mine']]));

    expect(body.content[0].name).toBe('Bash');
  });

  it('leaves text blocks and unmapped responses alone', () => {
    const body = { content: [{ type: 'text', text: 'hi' }] };

    expect(decloakToolNames(body, null)).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(decloakToolNames(body, new Map())).toEqual({ content: [{ type: 'text', text: 'hi' }] });
  });
});
