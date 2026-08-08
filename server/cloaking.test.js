const {
  applyCloaking,
  buildBillingHeader,
  buildUserId,
  conversationSeed,
  isOAuthToken,
  BILLING_PREFIX
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
