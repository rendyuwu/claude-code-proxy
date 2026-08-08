const SseToolNameRewriter = require('./SseToolNameRewriter');

const MAP = new Map([['search_web_ide', 'search_web']]);

const toolUseEvent = (name) => 'event: content_block_start\n'
  + `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"${name}","input":{}}}\n\n`;

const TEXT_EVENTS = 'event: message_start\n'
  + 'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n'
  + 'event: content_block_delta\n'
  + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n';

function run(chunks, map = MAP) {
  const rewriter = new SseToolNameRewriter(map);
  const out = [];

  return new Promise((resolve, reject) => {
    rewriter.on('data', chunk => out.push(chunk));
    rewriter.on('error', reject);
    rewriter.on('end', () => resolve(Buffer.concat(out).toString('utf8')));

    for (const chunk of chunks) {
      rewriter.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
    }
    rewriter.end();
  });
}

// Every byte boundary, because the network picks the split points, not us.
function everySplit(text) {
  const bytes = Buffer.from(text, 'utf8');
  const splits = [];
  for (let i = 1; i < bytes.length; i++) {
    splits.push([bytes.subarray(0, i), bytes.subarray(i)]);
  }
  return splits;
}

describe('SseToolNameRewriter', () => {
  it('puts the client tool name back into content_block_start', async () => {
    const output = await run([toolUseEvent('search_web_ide')]);

    expect(JSON.parse(output.split('data: ')[1]).content_block.name).toBe('search_web');
    expect(output).toMatch(/^event: content_block_start\n/);
    expect(output.endsWith('\n\n')).toBe(true);
  });

  it('forwards a stream with no tool call byte for byte', async () => {
    expect(await run([TEXT_EVENTS])).toBe(TEXT_EVENTS);
  });

  it('survives the event being split at any byte boundary', async () => {
    const stream = TEXT_EVENTS + toolUseEvent('search_web_ide');
    const expected = await run([stream]);

    for (const chunks of everySplit(stream)) {
      expect(await run(chunks)).toBe(expected);
    }
  });

  it('does not mangle a multi-byte character split across chunks', async () => {
    const text = 'event: content_block_delta\n'
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"日本語 — ok"}}\n\n';
    const bytes = Buffer.from(text, 'utf8');

    for (const chunks of everySplit(text)) {
      expect(await run(chunks)).toBe(text);
    }
    // The sample really does contain characters a naive split would break.
    expect(bytes.length).toBeGreaterThan(text.length);
  });

  it('leaves a name it did not rename, such as a decoy the model called', async () => {
    const output = await run([toolUseEvent('Bash')]);

    expect(output).toBe(toolUseEvent('Bash'));
  });

  it('forwards a data line it cannot parse', async () => {
    const broken = 'data: {"type":"content_block_start","content_block":{"type":"tool_use",\n\n';

    expect(await run([broken])).toBe(broken);
  });

  it('handles a data line written without the optional space', async () => {
    const line = 'data:{"type":"content_block_start","index":1,'
      + '"content_block":{"type":"tool_use","id":"tu_1","name":"search_web_ide","input":{}}}\n\n';

    const output = await run([line]);

    expect(output.startsWith('data:{')).toBe(true);
    expect(output).toContain('"name":"search_web"');
  });

  it('flushes a stream that ends without a final newline', async () => {
    const partial = 'data: {"type":"message_stop"}';

    expect(await run([partial])).toBe(partial);
  });

  it('emits nothing extra for an empty stream', async () => {
    expect(await run([])).toBe('');
  });
});
