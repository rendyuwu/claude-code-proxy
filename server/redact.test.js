const { redactHeaders } = require('./redact');

describe('redactHeaders', () => {
  it('never lets a credential value through', () => {
    const headers = {
      Authorization: 'Bearer sk-ant-oat01-SECRET-TOKEN-VALUE',
      'x-api-key': 'sk-ant-oat01-CLIENT-KEY',
      cookie: 'session=abc'
    };

    const serialized = JSON.stringify(redactHeaders(headers));

    expect(serialized).not.toContain('sk-ant-oat01-SECRET-TOKEN-VALUE');
    expect(serialized).not.toContain('sk-ant-oat01-CLIENT-KEY');
    expect(serialized).not.toContain('session=abc');
  });

  it('reports the length so a truncated token is still diagnosable', () => {
    expect(redactHeaders({ authorization: 'Bearer abc' }))
      .toEqual({ authorization: '<redacted:len=10>' });
    expect(redactHeaders({ authorization: '' }))
      .toEqual({ authorization: '<redacted:len=0>' });
  });

  it('matches the header name regardless of case', () => {
    expect(redactHeaders({ 'X-Api-Key': 'sk-ant-oat01-abc' }))
      .toEqual({ 'X-Api-Key': '<redacted:len=16>' });
  });

  it('leaves every other header untouched', () => {
    const headers = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'user-agent': 'claude-cli/2.1.92 (external, sdk-cli)'
    };

    expect(redactHeaders(headers)).toEqual(headers);
  });

  it('does not mutate the headers it was given', () => {
    const headers = { authorization: 'Bearer secret' };
    redactHeaders(headers);

    expect(headers.authorization).toBe('Bearer secret');
  });

  it('handles the array values Node uses for repeated headers', () => {
    expect(redactHeaders({ 'set-cookie': ['a=1', 'b=2'] }))
      .toEqual({ 'set-cookie': '<redacted:len=6>' });
  });

  it('passes through a missing header bag instead of throwing', () => {
    expect(redactHeaders(undefined)).toBeUndefined();
    expect(redactHeaders(null)).toBeNull();
  });
});
