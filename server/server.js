const http = require('http');
const url = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ClaudeRequest = require('./ClaudeRequest');
const Logger = require('./Logger');
const OAuthManager = require('./OAuthManager');
const { redactHeaders } = require('./redact');
const { exec } = require('child_process');

let config = {};

// PKCE state storage with automatic expiration (10 minutes)
const pkceStates = new Map();
const PKCE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function cleanupExpiredPKCE() {
  const now = Date.now();
  for (const [state, data] of pkceStates.entries()) {
    if (now - data.created_at > PKCE_EXPIRY_MS) {
      pkceStates.delete(state);
    }
  }
}

// Cleanup expired PKCE states every minute. unref'd so merely requiring this
// module (tests, tooling) does not keep the event loop alive forever; the
// listening server keeps the process up on its own.
setInterval(cleanupExpiredPKCE, 60000).unref();

function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.txt');
    const configFile = fs.readFileSync(configPath, 'utf8');
    
    configFile.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').trim();
        const commentIndex = value.indexOf('#');
        config[key.trim()] = commentIndex >= 0 ? value.substring(0, commentIndex).trim() : value;
      }
    });
    
    Logger.init(config);
    
    Logger.info('Config loaded from config.txt');
  } catch (error) {
    Logger.error('Failed to load config:', error.message);
    process.exit(1);
  }
}


function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        // Malformed client input is a 400, not a server fault.
        const badRequest = new Error(`Invalid JSON: ${error.message}`);
        badRequest.statusCode = 400;
        reject(badRequest);
      }
    });
    req.on('error', reject);
  });
}

// Optional gate on the proxy's own clients. Blank key keeps the old open
// behaviour; a set key means every /v1 call must carry it, because anyone who
// reaches this port otherwise spends the subscription behind it.
function proxyApiKey() {
  return (process.env.PROXY_API_KEY || config.proxy_api_key || '').trim();
}

function hasValidKey(req, key) {
  const presented = req.headers['x-api-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(String(presented));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Socket address only: x-forwarded-for is client-controlled, so trusting it
// here would let any remote caller claim to be local.
function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] ||
         req.headers['x-real-ip'] ||
         req.connection.remoteAddress ||
         '127.0.0.1';
}

function serveStaticFile(res, filePath, contentType) {
  const staticPath = path.join(__dirname, 'static', filePath);
  fs.readFile(staticPath, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function openBrowser(url) {
  let command;
  if (process.platform === 'darwin') {
    command = `open "${url}"`;
  } else if (process.platform === 'win32') {
    // start is a shell built-in; first quoted arg is window title, so use empty title
    command = `cmd /c start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      Logger.debug(`Failed to open browser: ${error.message}`);
    }
  });
}

function isRunningInDocker() {
  // Check for /.dockerenv file (Docker creates this)
  if (fs.existsSync('/.dockerenv')) return true;

  // Check /proc/self/cgroup for docker/containerd (Linux)
  try {
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    return cgroup.includes('docker') || cgroup.includes('containerd');
  } catch (err) {
    return false;
  }
}

async function handleRequest(req, res) {
  const clientIP = getClientIP(req);
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  Logger.info(`${req.method} ${pathname} from ${clientIP}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const apiKey = proxyApiKey();
  if (apiKey) {
    const isAuthRoute = pathname.startsWith('/auth/');
    // /auth/* is a browser flow that cannot set a header, so it stays reachable
    // from localhost (tunnel in if the port is remote) but never from off-box
    // without the key: /auth/login and /auth/logout both overwrite the tokens.
    const open = !isAuthRoute && !pathname.startsWith('/v1/');
    if (!open && !hasValidKey(req, apiKey) && !(isAuthRoute && isLoopback(req))) {
      Logger.warn(`Rejected ${pathname} from ${clientIP}: missing or wrong API key`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid or missing API key' }
      }));
      return;
    }
    // x-api-key otherwise means "use this as the upstream token". With the gate
    // on it is the proxy's own password, so drop it before ClaudeRequest tries
    // to spend it at api.anthropic.com and gets a 401 back.
    if (req.headers['x-api-key'] === apiKey) delete req.headers['x-api-key'];
  }

  // OAuth Routes
  if (pathname === '/auth/login' && req.method === 'GET') {
    serveStaticFile(res, 'login.html', 'text/html');
    return;
  }

  if (pathname === '/auth/get-url' && req.method === 'GET') {
    try {
      const pkce = OAuthManager.generatePKCE();
      pkceStates.set(pkce.state, {
        code_verifier: pkce.code_verifier,
        created_at: Date.now()
      });

      const authUrl = OAuthManager.buildAuthorizationURL(pkce);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: authUrl, state: pkce.state }));
      Logger.info('Generated OAuth authorization URL');
    } catch (error) {
      Logger.error('OAuth get-url error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to generate OAuth URL' }));
    }
    return;
  }

  if (pathname === '/auth/callback' && req.method === 'GET') {
    try {
      const query = parsedUrl.query;
      let code = query.code;
      let state = query.state;

      // Handle manual code entry format: "code#state"
      if (query.manual_code) {
        const parts = query.manual_code.split('#');
        if (parts.length !== 2) {
          throw new Error('Invalid code format. Expected: code#state');
        }
        code = parts[0];
        state = parts[1];
      }

      if (!code || !state) {
        throw new Error('Missing authorization code or state');
      }

      const pkceData = pkceStates.get(state);
      if (!pkceData) {
        throw new Error('Invalid or expired state parameter. Please start the authorization process again.');
      }

      pkceStates.delete(state);

      const tokens = await OAuthManager.exchangeCodeForTokens(code, pkceData.code_verifier, state);

      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000)
      };
      OAuthManager.saveTokens(tokenData);

      serveStaticFile(res, 'callback.html', 'text/html');
      Logger.info('OAuth authentication successful');
    } catch (error) {
      Logger.error('OAuth callback error:', error.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Authentication Failed</title></head>
        <body>
          <h1>Authentication Failed</h1>
          <p>Error: ${error.message}</p>
          <p><a href="/auth/login">Try again</a></p>
        </body>
        </html>
      `);
    }
    return;
  }

  if (pathname === '/auth/status' && req.method === 'GET') {
    try {
      const isAuthenticated = OAuthManager.isAuthenticated();
      const expiration = OAuthManager.getTokenExpiration();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        authenticated: isAuthenticated,
        expires_at: expiration ? expiration.toISOString() : null
      }));
    } catch (error) {
      Logger.error('Auth status error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to check authentication status' }));
    }
    return;
  }

  if (pathname === '/auth/logout' && req.method === 'GET') {
    try {
      OAuthManager.logout();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Logged out successfully' }));
      Logger.info('User logged out');
    } catch (error) {
      Logger.error('Logout error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to logout' }));
    }
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'claude-code-proxy', timestamp: Date.now() }));
    return;
  }
  
  // Forwarded so clients can enumerate models instead of hardcoding a list.
  if (pathname === '/v1/models' && req.method === 'GET') {
    const search = parsedUrl.search || '';
    await new ClaudeRequest(req).handleModels(res, search);
    return;
  }

  if (req.method === 'POST' && (pathname === '/v1/messages' || pathname.match(/^\/v1\/\w+\/messages$/))) {
    try {
      Logger.debug('Incoming request headers:', JSON.stringify(redactHeaders(req.headers), null, 2));
      const body = await parseBody(req);
      Logger.debug(`Claude request body (${JSON.stringify(body).length} bytes):`, JSON.stringify(body, null, 2));
      
      let presetName = null;
      const presetMatch = pathname.match(/^\/v1\/(\w+)\/messages$/);
      if (presetMatch) {
        presetName = presetMatch[1];

        // A typo in the preset name used to be a silent 200 with no preset
        // applied, so the client believed a preset was active when it was not.
        if (!ClaudeRequest.presetExists(presetName)) {
          Logger.warn(`Unknown preset: ${presetName}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `Unknown preset: ${presetName}`,
            available_presets: ClaudeRequest.availablePresets()
          }));
          return;
        }

        Logger.debug(`Detected preset: ${presetName}`);
      }

      await new ClaudeRequest(req).handleResponse(res, body, presetName);
    } catch (error) {
      Logger.error('Request error:', error.message);
      res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function startServer() {
  loadConfig();

  const server = http.createServer(handleRequest);
  const port = parseInt(config.port) || 3000;

  // Smart host binding: auto-detect Docker or use config
  const host = config.host || (isRunningInDocker() ? '0.0.0.0' : '127.0.0.1');

  server.listen(port, host, () => {
    Logger.info(`claude-code-proxy server listening on ${host}:${port}`);

    // Display authentication status, including the Claude Code fallback
    const credentials = ClaudeRequest.describeCredentialSource();
    const authUrl = `http://localhost:${port}/auth/login`;
    const usable = credentials.source !== 'none' && !credentials.expired;

    Logger.info('');
    Logger.info('Authentication Status:');
    if (credentials.source === 'proxy') {
      Logger.info(`  ✓ Authenticated with proxy OAuth tokens until ${credentials.expiresAt.toLocaleString()}`);
    } else if (credentials.source === 'claude-code' && !credentials.expired) {
      const until = credentials.expiresAt ? ` until ${credentials.expiresAt.toLocaleString()}` : '';
      Logger.info(`  ✓ Using Claude Code credentials (read-only)${until}`);
      Logger.info(`  → Run Claude Code to refresh them, or visit ${authUrl} to give the proxy its own tokens`);
    } else if (credentials.source === 'claude-code') {
      Logger.info('  ✗ Claude Code credentials found but expired');
      Logger.info(`  → Run Claude Code once to refresh them, or visit ${authUrl} to authenticate the proxy`);
    } else {
      Logger.info('  ✗ Not authenticated');
      Logger.info(`  → Visit ${authUrl} to authenticate`);
    }

    // Auto-open browser if configured (only works when running natively)
    const autoOpenBrowser = config.auto_open_browser !== 'false';
    if (!usable && autoOpenBrowser && !isRunningInDocker()) {
      Logger.info('  → Opening browser for authentication...');
      setTimeout(() => openBrowser(authUrl), 1000);
    }
    Logger.info('');
  });

  process.on('SIGTERM', () => {
    Logger.info('Shutting down...');
    server.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    Logger.info('Shutting down...');
    server.close(() => process.exit(0));
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, handleRequest, ClaudeRequest };
