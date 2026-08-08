const { Transform } = require('stream');
const { StringDecoder } = require('string_decoder');

// A tool name reaches the client in exactly one streaming event: the
// content_block_start that opens a tool_use block. input_json_delta carries only
// the argument JSON, so nothing else has to be touched.
const DATA_PREFIX = /^data:[ ]?/;

/**
 * Restores the client's own tool names in a streamed response, undoing the
 * suffix cloakTools applied on the way out.
 *
 * Chunk boundaries fall wherever the network puts them, so lines are buffered
 * until they are complete and multi-byte characters are decoded across chunks.
 * Anything that is not a tool_use content_block_start is passed through byte for
 * byte — including the SSE framing, which the client's parser depends on.
 */
class SseToolNameRewriter extends Transform {
  constructor(toolNameMap) {
    super();
    this.toolNameMap = toolNameMap;
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
  }

  _transform(chunk, encoding, callback) {
    this.pending += this.decoder.write(chunk);

    const lastBreak = this.pending.lastIndexOf('\n');
    if (lastBreak === -1) {
      callback();
      return;
    }

    const complete = this.pending.slice(0, lastBreak + 1);
    this.pending = this.pending.slice(lastBreak + 1);

    callback(null, this.rewrite(complete));
  }

  _flush(callback) {
    const remainder = this.pending + this.decoder.end();
    callback(null, remainder ? this.rewrite(remainder) : null);
  }

  rewrite(text) {
    // Only lines that could name a tool are parsed; text deltas are the bulk of
    // a stream and must not pay for JSON round-tripping.
    if (!text.includes('"tool_use"')) return text;

    return text
      .split('\n')
      .map(line => this.rewriteLine(line))
      .join('\n');
  }

  rewriteLine(line) {
    const prefix = line.match(DATA_PREFIX);
    if (!prefix || !line.includes('"tool_use"')) return line;

    let event;
    try {
      event = JSON.parse(line.slice(prefix[0].length));
    } catch (error) {
      // Not our business to repair; forward it as it arrived.
      return line;
    }

    const block = event?.content_block;
    if (event?.type !== 'content_block_start' || block?.type !== 'tool_use') return line;
    if (!this.toolNameMap.has(block.name)) return line;

    block.name = this.toolNameMap.get(block.name);
    return `${prefix[0]}${JSON.stringify(event)}`;
  }
}

module.exports = SseToolNameRewriter;
