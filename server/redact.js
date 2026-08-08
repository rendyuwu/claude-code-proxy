// Header values that carry a live credential. Debug logging used to print
// request headers verbatim, so anyone who set log_level=DEBUG to chase a bug
// wrote a working Claude token — theirs or a client's — into the log.
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'cookie',
  'set-cookie'
]);

// Length is kept because "is the token empty or truncated?" is the usual reason
// to read these back, and that question does not need the secret itself.
function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;

  const redacted = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SECRET_HEADERS.has(key.toLowerCase())) {
      redacted[key] = value;
      continue;
    }

    const length = Array.isArray(value)
      ? value.join('').length
      : String(value ?? '').length;
    redacted[key] = `<redacted:len=${length}>`;
  }

  return redacted;
}

module.exports = { redactHeaders, SECRET_HEADERS };
