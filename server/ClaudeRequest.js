const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const Logger = require('./Logger');
const OAuthManager = require('./OAuthManager');

// Load configuration
const loadConfig = () => {
  try {
    const configPath = path.join(__dirname, 'config.txt');
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = {};

    configData.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const commentIndex = trimmed.indexOf('#');
      const cleanLine = commentIndex !== -1 ? trimmed.substring(0, commentIndex).trim() : trimmed;

      const [key, value] = cleanLine.split('=').map(s => s.trim());
      if (key && value !== undefined) {
        config[key] = value === 'true' ? true : value === 'false' ? false : value;
      }
    });

    return config;
  } catch (error) {
    Logger.warn(`Failed to load config: ${error.message}`);
    return {};
  }
};

const CONFIG = loadConfig();
const FILTER_SAMPLING_PARAMS = CONFIG.filter_sampling_params === true; // Default to false
const FALLBACK_TO_CLAUDE_CODE = CONFIG.fallback_to_claude_code !== false; // Default to true
// api.anthropic.com accepts cache_control.ttl on the Claude Code OAuth path,
// verified against a live 1h breakpoint. Stripping it silently downgraded every
// 1h request to the 5m default, so the strip is opt-in for the case where a
// future upstream change starts rejecting the field again.
const STRIP_CACHE_CONTROL_TTL = CONFIG.strip_cache_control_ttl === true; // Default to false
// Socket inactivity timeout, not a total deadline: streaming responses keep
// resetting it, so only a genuinely stalled upstream trips it.
const UPSTREAM_TIMEOUT_MS = parseInt(CONFIG.upstream_timeout_ms, 10) || 300000;

class ClaudeRequest {
  static presetCache = new Map();

  constructor(req = null) {
    this.API_URL = 'https://api.anthropic.com/v1/messages';
    this.VERSION = '2023-06-01';
    this.BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';

    // A client-supplied token belongs to this request only. It used to be
    // written to a static cache, so one client's key was handed to every other
    // client sharing the process.
    this.headerToken = null;
    const apiKey = req?.headers?.['x-api-key'];
    if (apiKey && apiKey.includes('sk-ant')) {
      Logger.debug('Using x-api-key as token for this request');
      this.headerToken = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
    }
  }

  // Unconditional; the caller decides whether to run it. Every place a
  // cache_control object can appear is covered: tools used to be skipped, so a
  // request could end up with a 1h breakpoint on tools and a 5m one on system.
  stripTtlFromCacheControl(body) {
    if (!body || typeof body !== 'object') return body;

    const processContentArray = (contentArray) => {
      if (!Array.isArray(contentArray)) return;

      contentArray.forEach(item => {
        if (item && typeof item === 'object' && item.cache_control) {
          if (item.cache_control.ttl) {
            delete item.cache_control.ttl;
            Logger.debug('Removed ttl from cache_control');
          }
          if (item.cache_control.scope) {
            delete item.cache_control.scope;
            Logger.debug('Removed scope from cache_control');
          }
        }
      });
    };

    processContentArray(body.tools);
    processContentArray(body.system);

    if (Array.isArray(body.messages)) {
      body.messages.forEach(message => {
        if (message && Array.isArray(message.content)) {
          processContentArray(message.content);
        }
      });
    }

    return body;
  }

  filterSamplingParams(body) {
    if (!FILTER_SAMPLING_PARAMS) return body;
    if (!body || typeof body !== 'object') return body;

    const hasTemperature = body.temperature !== undefined;
    const hasTopP = body.top_p !== undefined;

    // If both are present, we need to keep only one
    if (hasTemperature && hasTopP) {
      const tempIsDefault = body.temperature === 1.0;
      const topPIsDefault = body.top_p === 1.0;

      // If both are default, remove top_p (arbitrary choice)
      if (tempIsDefault && topPIsDefault) {
        delete body.top_p;
        Logger.debug('Removed top_p=1.0 from request (both at default, keeping temperature)');
      }
      // If only top_p is default, remove it
      else if (topPIsDefault) {
        delete body.top_p;
        Logger.debug(`Removed top_p=1.0 from request (keeping temperature=${body.temperature})`);
      }
      // If only temperature is default, remove it and keep top_p
      else if (tempIsDefault) {
        delete body.temperature;
        Logger.debug(`Removed temperature=1.0 from request (keeping top_p=${body.top_p})`);
      }
      // If both are non-default, prefer temperature over top_p
      else {
        const topPValue = body.top_p;
        delete body.top_p;
        Logger.debug(`Removed top_p=${topPValue} from request (preferring temperature=${body.temperature})`);
      }
    }
    // If only top_p is present and it's default, remove it
    else if (hasTopP && body.top_p === 1.0) {
      delete body.top_p;
      Logger.debug('Removed top_p=1.0 from request (default value, no temperature specified)');
    }
    // If only temperature is present and it's default, remove it
    else if (hasTemperature && body.temperature === 1.0) {
      delete body.temperature;
      Logger.debug('Removed temperature=1.0 from request (default value, no top_p specified)');
    }

    return body;
  }

  async getAuthToken() {
    if (this.headerToken) {
      return this.headerToken;
    }

    // No process-wide token cache: OAuthManager caches its own token and
    // validates expiry against the token file, and the Claude Code fallback
    // re-reads expiresAt on every call. A second cache here only added a way
    // to serve an expired or foreign token.
    return await this.loadOrRefreshToken();
  }

  // 401, not 500: a missing or expired credential is the caller's problem to
  // act on. userFacing keeps the message from being wrapped again on the way out.
  authError(message) {
    const error = new Error(message);
    error.statusCode = 401;
    error.userFacing = true;
    return error;
  }

  async loadOrRefreshToken({ force = false } = {}) {
    try {
      // Try OAuthManager's stored tokens first
      if (OAuthManager.isAuthenticated()) {
        Logger.debug('Using OAuthManager tokens');
        if (force) {
          Logger.info('Forcing OAuth token refresh');
          const response = await OAuthManager.refreshAccessToken();
          return `Bearer ${response.access_token}`;
        }
        const token = await OAuthManager.getValidAccessToken();
        return `Bearer ${token}`;
      }

      // Fallback to Claude Code credentials if enabled
      if (FALLBACK_TO_CLAUDE_CODE) {
        Logger.debug('Falling back to Claude Code credentials');
        return await this.loadFromClaudeCodeCredentials({ force });
      }

      throw this.authError('No authentication tokens found. Please authenticate first.');
    } catch (error) {
      if (error.userFacing) throw error;
      throw this.authError(`Failed to get auth token: ${error.message}`);
    }
  }

  async loadFromClaudeCodeCredentials({ force = false } = {}) {
    try {
      const credentialsData = this.loadCredentialsFromFile();
      const credentials = JSON.parse(credentialsData);
      const oauth = credentials.claudeAiOauth;

      if (!oauth || !oauth.accessToken) {
        throw new Error('no claudeAiOauth section in credentials file');
      }

      // Read-only by design. Anthropic rotates the refresh token on every
      // refresh, so refreshing here would invalidate the token Claude Code
      // still holds in this same file and break the user's Claude Code login.
      if (force || (oauth.expiresAt && Date.now() >= (oauth.expiresAt - 10000))) {
        throw this.authError(
          'Claude Code access token expired. Run Claude Code once so it refreshes its own token, ' +
          'or authenticate the proxy separately at /auth/login'
        );
      }

      return `Bearer ${oauth.accessToken}`;
    } catch (error) {
      if (error.userFacing) throw error;
      if (error.code === 'ENOENT') {
        throw this.authError(
          process.platform === 'win32'
            ? 'Claude credentials file not found in WSL. Check your default WSL distro with "wsl -l -v" and set the correct one with "wsl --set-default <distro-name>". As a backup, you can get the token from ~/.claude/.credentials.json and pass it as x-api-key (proxy password in SillyTavern)'
            : 'Claude credentials not found. Please ensure Claude Code is installed and you have logged in. As a backup, you can get the token from ~/.claude/.credentials.json and pass it as x-api-key (proxy password in SillyTavern)'
        );
      }
      throw this.authError(`Failed to load Claude Code credentials: ${error.message}`);
    }
  }

  loadCredentialsFromFile() {
    if (process.platform === 'win32') {
      // Try native Windows location first
      const nativePath = path.join(os.homedir(), '.claude', '.credentials.json');
      if (fs.existsSync(nativePath)) {
        return fs.readFileSync(nativePath, 'utf8');
      }
      // Fallback to WSL for users who still have the old setup
      return execSync('wsl cat ~/.claude/.credentials.json', { encoding: 'utf8', timeout: 10000 });
    } else {
      // macOS/Linux use the same path convention
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      return fs.readFileSync(credentialsPath, 'utf8');
    }
  }

  getHeaders(token) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': token,
      'anthropic-version': this.VERSION,
      'User-Agent': 'claude-code-proxy/1.0.0',
      // The non-streaming path re-serializes the body without decompressing it,
      // so ask upstream not to compress in the first place.
      'Accept-Encoding': 'identity'
    };

    if (this.BETA_HEADER) {
      headers['anthropic-beta'] = this.BETA_HEADER;
    }

    return headers;
  }

  // Deep copy so the caller's body is never mutated. The 401 retry path calls
  // processRequestBody() a second time with the same body object, and in-place
  // mutation made it inject the system prompt and preset suffix twice.
  cloneBody(body) {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(body);
      } catch (error) {
        Logger.debug(`structuredClone failed, using JSON clone: ${error.message}`);
      }
    }
    return JSON.parse(JSON.stringify(body));
  }

  // Anthropic accepts system as a string or as a content-block array. Everything
  // downstream (system prompt injection, applyPreset) works on the array form,
  // so normalize once here.
  normalizeSystem(system) {
    if (!system) return [];
    if (Array.isArray(system)) return system;
    return [{ type: 'text', text: system }];
  }

  processRequestBody(body, presetName = null) {
    if (!body) return body;

    let processed = this.cloneBody(body);

    // Skip system prompt injection for Haiku models
    const isHaiku = processed.model && processed.model.toLowerCase().includes('haiku');

    processed.system = this.normalizeSystem(processed.system);

    if (!isHaiku) {
      processed.system.unshift({
        type: 'text',
        text: 'You are Claude Code, Anthropic\'s official CLI for Claude.'
      });
    } else {
      Logger.debug('Skipping Claude Code system prompt for Haiku model');
    }

    if (presetName) {
      this.applyPreset(processed, presetName);
    }

    // Never send an empty system array upstream.
    if (processed.system.length === 0) {
      delete processed.system;
    }

    if (STRIP_CACHE_CONTROL_TTL) {
      processed = this.stripTtlFromCacheControl(processed);
    }
    processed = this.filterSamplingParams(processed);

    return processed;
  }

  // Startup used to report "Not authenticated" whenever the proxy had no
  // tokens.json of its own, even though every request succeeded through the
  // Claude Code fallback. Report what will actually be used.
  static describeCredentialSource() {
    if (OAuthManager.isAuthenticated()) {
      return { source: 'proxy', expiresAt: OAuthManager.getTokenExpiration(), expired: false };
    }

    if (!FALLBACK_TO_CLAUDE_CODE) {
      return { source: 'none' };
    }

    try {
      const credentials = JSON.parse(new ClaudeRequest().loadCredentialsFromFile());
      const oauth = credentials.claudeAiOauth;
      if (!oauth || !oauth.accessToken) {
        return { source: 'none' };
      }
      return {
        source: 'claude-code',
        expiresAt: oauth.expiresAt ? new Date(oauth.expiresAt) : null,
        expired: !!(oauth.expiresAt && Date.now() >= (oauth.expiresAt - 10000))
      };
    } catch (error) {
      return { source: 'none' };
    }
  }

  static presetsDir() {
    return path.join(__dirname, 'presets');
  }

  static presetExists(presetName) {
    if (!/^\w+$/.test(presetName)) return false;
    return fs.existsSync(path.join(ClaudeRequest.presetsDir(), `${presetName}.json`));
  }

  static availablePresets() {
    try {
      return fs.readdirSync(ClaudeRequest.presetsDir())
        .filter(name => name.endsWith('.json'))
        .map(name => name.slice(0, -'.json'.length))
        .sort();
    } catch (error) {
      Logger.warn(`Failed to list presets: ${error.message}`);
      return [];
    }
  }

  loadPreset(presetName) {
    if (ClaudeRequest.presetCache.has(presetName)) {
      return ClaudeRequest.presetCache.get(presetName);
    }

    try {
      const presetPath = path.join(__dirname, 'presets', `${presetName}.json`);
      const presetData = fs.readFileSync(presetPath, 'utf8');
      const preset = JSON.parse(presetData);
      ClaudeRequest.presetCache.set(presetName, preset);
      return preset;
    } catch (error) {
      Logger.info(`Failed to load preset ${presetName}: ${error.message}`);
      ClaudeRequest.presetCache.set(presetName, null);
      return null;
    }
  }

  // A cache_control breakpoint marks the end of the cached prefix, so anything
  // appended after it is re-billed at full price on every request. Injected
  // preset text is byte-identical each time, so it belongs inside the prefix:
  // hand the client's trailing breakpoint to the injected block instead of
  // adding a new one. The breakpoint count is unchanged (the API allows 4) and
  // the client's own content stays inside the prefix either way.
  moveTrailingBreakpoint(fromBlock, toBlock) {
    if (!fromBlock || !toBlock || !fromBlock.cache_control) return;

    toBlock.cache_control = fromBlock.cache_control;
    delete fromBlock.cache_control;
    Logger.debug('Moved cache_control breakpoint onto injected preset block');
  }

  applyPreset(body, presetName) {
    const preset = this.loadPreset(presetName);
    if (!preset) {
      Logger.warn(`Unknown preset: ${presetName}`);
      return;
    }

    if (preset.system) {
      const presetSystemPrompt = {
        type: 'text',
        text: preset.system
      };
      const previousLast = body.system[body.system.length - 1];
      body.system.push(presetSystemPrompt);
      this.moveTrailingBreakpoint(previousLast, presetSystemPrompt);
    }

    // Use suffixEt only when thinking is enabled, otherwise use regular suffix
    const hasThinking = body.thinking && body.thinking.type === 'enabled';
    const suffix = hasThinking ? preset.suffixEt : preset.suffix;

    if (suffix && body.messages && body.messages.length > 0) {
      const lastUserIndex = body.messages.map(m => m.role).lastIndexOf('user');
      if (lastUserIndex !== -1) {
        const suffixBlock = { type: 'text', text: suffix };
        body.messages.splice(lastUserIndex + 1, 0, {
          role: 'user',
          content: [suffixBlock]
        });

        // Only an array content can carry a breakpoint; a plain string cannot.
        const lastUserContent = body.messages[lastUserIndex].content;
        if (Array.isArray(lastUserContent) && lastUserContent.length > 0) {
          this.moveTrailingBreakpoint(lastUserContent[lastUserContent.length - 1], suffixBlock);
        }
      }
    }

    Logger.debug(`Applied preset: ${presetName}`);
  }

  async makeRequest(body, presetName = null, tokenOverride = null) {
    const token = tokenOverride || await this.getAuthToken();
    const headers = this.getHeaders(token);
    const processedBody = this.processRequestBody(body, presetName);

    Logger.debug('Outgoing headers to Claude:', JSON.stringify(headers, null, 2));
    Logger.debug(`Final request to Claude (${JSON.stringify(processedBody).length} bytes):`, JSON.stringify(processedBody, null, 2));

    const urlParts = new URL(this.API_URL);
    const options = {
      hostname: urlParts.hostname,
      port: urlParts.port || 443,
      path: urlParts.pathname,
      method: 'POST',
      headers: headers
    };

    return this.sendUpstream(options, JSON.stringify(processedBody));
  }

  async makeGetRequest(pathWithQuery, tokenOverride = null) {
    const token = tokenOverride || await this.getAuthToken();
    const headers = this.getHeaders(token);
    delete headers['Content-Type'];

    const urlParts = new URL(this.API_URL);
    const options = {
      hostname: urlParts.hostname,
      port: urlParts.port || 443,
      path: pathWithQuery,
      method: 'GET',
      headers: headers
    };

    Logger.debug(`Upstream GET ${pathWithQuery}`);
    return this.sendUpstream(options);
  }

  sendUpstream(options, payload = null) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const req = https.request(options, (res) => {
        settled = true;
        resolve(res);
      });

      // Without this a hung upstream held the client request open forever.
      req.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
        Logger.error(`Upstream request idle for ${UPSTREAM_TIMEOUT_MS}ms, aborting`);
        req.destroy(new Error(`Upstream request timeout after ${UPSTREAM_TIMEOUT_MS}ms`));
      });

      req.on('error', (err) => {
        req.destroy();
        // Once the response is handed off, streamResponse owns the error path.
        if (settled) {
          Logger.error(`Upstream request error after response started: ${err.message}`);
          return;
        }
        reject(err);
      });

      if (payload !== null) {
        req.write(payload);
      }
      req.end();
    });
  }

  async handleResponse(res, body, presetName = null) {
    return this.proxyUpstream(res, (token) => this.makeRequest(body, presetName, token));
  }

  async handleModels(res, search = '') {
    return this.proxyUpstream(res, (token) => this.makeGetRequest(`/v1/models${search}`, token));
  }

  // Single place that owns the 401-retry, header copy and body forwarding for
  // every upstream call. send(token) receives null on the first attempt.
  async proxyUpstream(res, send) {
    try {
      const claudeResponse = await send(null);

      // A 401 on a client-supplied x-api-key is the client's problem: do not
      // silently retry it with the proxy owner's subscription credentials.
      if (claudeResponse.statusCode === 401 && !this.headerToken) {
        Logger.info('Got 401, forcing credential refresh and retrying once');

        try {
          const newToken = await this.loadOrRefreshToken({ force: true });
          claudeResponse.destroy();
          const retryResponse = await send(newToken);
          res.statusCode = retryResponse.statusCode;
          Logger.debug(`Claude API retry status: ${retryResponse.statusCode}`);
          Logger.debug('Claude retry response headers:', JSON.stringify(retryResponse.headers, null, 2));
          this.copyResponseHeaders(res, retryResponse);
          this.streamResponse(res, retryResponse);
          return;
        } catch (error) {
          Logger.info(`Token load/refresh failed, passing 401 to client: ${error.message}`);
        }
      } else if (claudeResponse.statusCode === 401) {
        Logger.info('Got 401 for client-supplied x-api-key, passing it through');
      }

      res.statusCode = claudeResponse.statusCode;
      Logger.debug(`Claude API status: ${claudeResponse.statusCode}`);
      Logger.debug('Claude response headers:', JSON.stringify(claudeResponse.headers, null, 2));
      this.copyResponseHeaders(res, claudeResponse);

      this.streamResponse(res, claudeResponse);

    } catch (error) {
      Logger.error('Claude request error:', error.message);
      res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  // Never forward body-framing or hop-by-hop headers. The non-streaming path
  // re-serializes the JSON, so upstream's content-length is not guaranteed to
  // match what we actually send; Node sets the framing headers itself.
  copyResponseHeaders(res, claudeResponse) {
    const skipped = new Set([
      'content-length',
      'content-encoding',
      'transfer-encoding',
      'connection',
      'keep-alive'
    ]);

    Object.keys(claudeResponse.headers).forEach(key => {
      if (skipped.has(key.toLowerCase())) return;
      res.setHeader(key, claudeResponse.headers[key]);
    });
  }

  streamResponse(res, claudeResponse) {
    const extractClaudeText = (chunk) => {
      try {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.substring(6));
            if (data.type === 'content_block_delta') {
              if (data.delta?.type === 'text_delta') {
                return { text: data.delta.text };
              }
              if (data.delta?.type === 'thinking_delta') {
                return { thinking: data.delta.thinking };
              }
            }
          }
        }
      } catch (e) {
      }
      return null;
    };

    const contentType = claudeResponse.headers['content-type'] || '';
    if (contentType.includes('text/event-stream')) {
      Logger.debug('Outgoing response headers to client:', JSON.stringify(res.getHeaders(), null, 2));
      
      claudeResponse.on('error', (err) => {
        Logger.debug('Claude response stream error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        if (!res.destroyed) {
          res.end(JSON.stringify({ error: 'Upstream response error' }));
        }
      });
      
      res.on('close', () => {
        Logger.debug('Client disconnected, cleaning up streams');
        if (!claudeResponse.destroyed) {
          claudeResponse.destroy();
        }
      });
      
      if (Logger.getLogLevel() >= 3) {
        const debugStream = Logger.createDebugStream('Claude SSE', extractClaudeText);
        
        debugStream.on('error', (err) => {
          Logger.debug('Debug stream error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
          }
          if (!res.destroyed) {
            res.end(JSON.stringify({ error: 'Stream processing error' }));
          }
        });
        
        claudeResponse.pipe(debugStream).pipe(res);
        debugStream.on('end', () => {
          Logger.debug('\n');
          Logger.debug('Streaming response sent back to client');
        });
      } else {
        claudeResponse.pipe(res);
        claudeResponse.on('end', () => {
          Logger.debug('Streaming response sent back to client');
        });
      }
    } else {
      let responseData = '';
      claudeResponse.on('data', chunk => {
        responseData += chunk;
      });

      claudeResponse.on('error', (err) => {
        Logger.error('Claude non-streaming response error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        if (!res.destroyed) {
          res.end(JSON.stringify({ error: 'Upstream error', message: err.message }));
        }
      });

      claudeResponse.on('end', () => {
        Logger.debug(`Non-streaming response (${claudeResponse.statusCode}): ${responseData.substring(0, 500)}`);
        if (res.headersSent || res.destroyed) return;

        try {
          const payload = JSON.stringify(JSON.parse(responseData));
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Length', Buffer.byteLength(payload));
          Logger.debug('Outgoing response headers to client:', JSON.stringify(res.getHeaders(), null, 2));
          res.end(payload);
          Logger.debug('Non-streaming response sent back to client');
        } catch (e) {
          res.setHeader('Content-Length', Buffer.byteLength(responseData));
          res.end(responseData);
          Logger.debug('Raw response sent back to client');
        }
      });
    }
  }
}

module.exports = ClaudeRequest;
