# claude-code-proxy
## About

Mostly vibe coded, my node skills suck ass, don't @ me (kidding, I'm open to suggestions and bug reports)

Basically we can borrow Claude Code subscription authentication to make normal API calls at will, using claude.ai limit rather than API prices.

There seems to be no safety injection and it gives us full control of the entire input, minus a tiny required sentence about being Claude Code in the system prompt (check What This Does section)

Obviously this is probably not super cool in terms of ToS. But I'm not worried, historically they don't ban web subscribers unless there's VPN/location/sus email/payment shenanigans (as opposed to API which does get got occasionally).

**NEW:** This proxy now has **standalone OAuth authentication**! You no longer need to install Claude Code - just authenticate through your browser. Claude Code credentials are still supported as an optional fallback.

## Quick Start

### Option 1: Standalone OAuth (Recommended - No Claude Code needed!)
Requires:
- Node.js (installed with nvm recommended)
- Claude MAX subscription

1. `git clone https://github.com/horselock/claude-code-proxy.git`
2. `npm install` (first time only, to install test dependencies)
3. `run.sh` or `run.bat` depending on your OS; default port is 42069
4. Browser will open automatically - authenticate with your Claude account
5. Done! The proxy is now authenticated and ready to use

### Option 2: Using Claude Code Credentials (Legacy)
If you already have Claude Code installed and prefer to use its credentials:
- The proxy will automatically fall back to Claude Code credentials if no OAuth tokens are found
- Set `fallback_to_claude_code=true` in `server/config.txt` (default)
- This fallback is **read-only**: the proxy reads `~/.claude/.credentials.json` and never writes to it. Anthropic rotates the refresh token on every refresh, so a proxy-side refresh would invalidate the token Claude Code still holds in that same file. When the access token expires, the proxy answers 401 and asks you to run Claude Code once (which refreshes its own token) or to authenticate the proxy at `/auth/login`. Option 1 avoids this entirely

### Docker startup
1. `docker-compose up`
2. Visit `http://localhost:42069/auth/login` to authenticate

**Important Notes:**
- NOT an OpenAI compatible proxy, uses Anthropic's schema
- Which models you can use depends on your account. Ask the proxy instead of guessing: `GET http://localhost:42069/v1/models` forwards the request upstream and returns the list your credentials are actually allowed to use. As of 2026-08-06 a Max account returns `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001` and `claude-sonnet-4-5-20250929`. Undated aliases such as `claude-haiku-4-5`, `claude-opus-4-5` and `claude-sonnet-4-5` work too; models your account has no access to come back as a 404 from Anthropic, forwarded as-is
- Understand your front end's caching, some FEs like ST disable by default, complex RP setups may consistently miss cache and increase costs

## Authentication

### OAuth Authentication (Standalone)

The proxy now supports **standalone OAuth authentication** - no Claude Code installation required! When you start the server:

1. If not authenticated, your browser will automatically open to `/auth/login`
2. You'll be redirected to claude.ai to authorize the application
3. After approval, tokens are saved to `~/.claude-code-proxy/tokens.json`
4. Tokens refresh automatically when they expire

**Manual Authentication:**
- Visit `http://localhost:42069/auth/login` to authenticate
- Check status: `http://localhost:42069/auth/status`
- Logout: `http://localhost:42069/auth/logout`

**Configuration Options** (in `server/config.txt`):
```
auto_open_browser=true           # Automatically open browser on first run
fallback_to_claude_code=true     # Use Claude Code credentials as fallback
host=                            # Leave blank for auto-detect (127.0.0.1 native, 0.0.0.0 Docker)
upstream_timeout_ms=300000       # Abort a request to api.anthropic.com after this much socket inactivity
```

**Token Priority:**
1. `x-api-key` header (if provided in requests) - used for that request only, never cached for other clients. If Anthropic rejects it, you get the 401 back instead of the proxy quietly falling back to its own credentials
2. OAuth tokens from `~/.claude-code-proxy/tokens.json` - refreshed automatically
3. Claude Code credentials from `~/.claude/.credentials.json` (if fallback enabled) - read-only, never refreshed by the proxy

### Claude Code Credentials (Legacy Fallback)

If you have Claude Code installed, the proxy can use its credentials as a fallback:
- Automatically used if OAuth tokens don't exist and `fallback_to_claude_code=true`
- Requires Claude Code to be installed and logged in
- Read-only: the proxy never refreshes or rewrites `~/.claude/.credentials.json`. An expired token there is a 401 telling you to run Claude Code or to authenticate the proxy separately
- See the "Beginner/Thorough Guide" section below for Claude Code setup instructions

## Beginner/Thorough Guide

**Note:** With the new OAuth authentication, you may skip the Claude Code installation steps entirely! This guide is kept for users who prefer the Claude Code fallback method.

This guide assumes windows (untested on Linux but should work fine), and no wsl/nvm/node already installed. Just skip any sections you already have done.

### Install Claude Code 

#### wsl
1. Open a command line and run `wsl --install`. Follow instructions. If you aren't already in by the end, `wsl` (either in command line or from start menu) to enter the shell, you should get colors and a dollar sign: [example](https://www.jeremymorgan.com/images/customize-wsl-terminal/customize-wsl-terminal-01.jpg)

#### nvm and node
Even if you already have node in Windows, you'll need it again in wsl. If you already installed it NOT with nvm (Node Version Manager), remove it (ask Claude to guide if unsure) and reinstall - it's better anyway.

1. While in wsl, install nvm t: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash` - See [their guide](https://github.com/nvm-sh/nvm?tab=readme-ov-file#install--update-script) for latest version.
2. Still in the colorful wsl terminal, install node: `nvm install --lts` - LTS stands for long term support

#### claude code
While in wsl terminal, run `npm install -g @anthropic-ai/claude-code`

Details here: https://docs.anthropic.com/en/docs/claude-code/setup

You're done!

### Install SillyTavern (or any front end of your choice, but I'm only walking through ST)
1. https://docs.sillytavern.app/installation/windows/ - I think their "installer" option is actually really easy, should take care of everything.
2. FYI: In the leftmost tab of "AI Response Configruation", you'll want to check "Use system prompt". This is also where you toggle thinking (reasoning effort), and most things, really.

### My Application
1. Install Git for Windows and run (in command line or powershell) `git clone https://github.com/horselock/claude-code-proxy.git`. If you really really don't want git, then download and unzip the whole project.
2. Double-click `run.bat` (Windows) or `run.sh` (Mac/Linux)
3. Go into SillyTavern and point the Claude connection to that proxy:

<img width="638" alt="image" src="https://github.com/user-attachments/assets/3b94e5c4-d52d-4ee8-8d26-675ba667f7a8" />

- URL = `http://localhost:42069/v1`
- Literally anything for password, just don't leave blank. As a backup option, you may put your oauth access token here (see Troubleshooting section)
- You have to pick a specific model name, "latest" won't work. Open `http://localhost:42069/v1/models` in a browser to see exactly which names your account accepts. 
- Save the preset as "Claude Code Proxy" or whatever you want.
- Click "Connect"

### Optional (but important to read for ST noobs)
- Strip down SillyTavern to make it a plain chat client. Not saying you necessarily *should* do this, but it's useful to know how to do it.
  - In leftmost tab, open the "Utility Prompts" drop-down and delete "[Start a new Chat]" - this would put that line at convo start, weird and unnecessary.
  - In leftmost tab, scroll down to "Main Prompt" and delete or disable it.
  - In the rightmost tab, click on the pre-made "Assistant" character.
  - You now have a baseline of a "pure" API call, feel free to explore ST's features from there!
- Probably should increase Max Tokens so responses don't get cut off.
- Try loading up Pyrite, my jailbroken persona!
  - I've pre-loaded Pyrite on the server. Just set your url to `http://localhost:42069/v1/pyrite`! This is meant for people who JUST installed a front and and don't have a real setup yet - it's nice to be able to celebrate your victory with something working right away!
- Read up on how SillyTavern handles caching: https://docs.sillytavern.app/administration/config-yaml/#claude-configuration
  - It's off by default, turn it on with those configs. Choose depth 0 if you aren't sure; this caches the most aggressively.
  - What all those warnings mean is that for cache to be used, the convo history up to a certain point has to be the exact same. ST has a lot of advanced features where it makes changes to the start of the context, ruining your savings. But for simpler use cases, it's fine. Set the context to 200K IMO - as stuff falls out of context if you choose a lower number, that changes the convo start 

### Troubleshooting

#### OAuth Authentication Issues
- **Browser doesn't open automatically**: Visit `http://localhost:42069/auth/login` manually
- **Authentication fails**: Make sure you're logged into claude.ai in your browser
- **Tokens expire**: They refresh automatically, but if you see auth errors, try logging out and in again
- **Check authentication status**: Visit `http://localhost:42069/auth/status`

#### Claude Code Fallback Issues (Legacy)
Most likely thing to go wrong is not being able to find the credentials, either due to permissions or location.
- Ensure you installed node in wsl with nvm, if not, just redo it.
- Make sure your wsl default is Ubuntu (the default distro that comes with wsl)
- If all else fails, go to wsl, `cat ~/.claude/.credentials.json`, copy out the access token (after sending a message from Claude Code first to make sure it's not expired), and put it in the authentication header. In ST, this is the Proxy "password".
  - If that's one too steps, you can go to util folder, enter wsl in the address bar, and run `claude-bearer.js` - that'll make sure it's not expired, and you'll get the token delivered to you. You don't have to copy "Bearer"
- The proxy no longer renews Claude Code's token for you (it used to, which could log Claude Code out). If the proxy starts returning 401 with "Claude Code access token expired", send one message from Claude Code so it refreshes the file, or authenticate the proxy on its own at `/auth/login`.

## What This Does

### Authentication
- **OAuth Flow**: Implements PKCE OAuth 2.0 flow to authenticate directly with claude.ai
- **Token Management**: Automatically refreshes its own OAuth tokens (`~/.claude-code-proxy/tokens.json`) when they expire
- **Fallback Support**: Can optionally read Claude Code credentials as a fallback, without ever writing to that file

### Request Processing
- Adds headers (Authorization plus a couple specified in config.txt) to trick the endpoint into thinking the request is coming from a real Claude Code application
- Remove "ttl" key from any "cache_control" objects, since endpoint does not allow it
- The first section of the system prompt must be "You are Claude Code, Anthropic's official CLI for Claude." or the request will not be accepted by Anthropic (specifically/technically, it must be the first item of the "system" array's "text" content). I am adding this, but this is just FYI so you know it's there and that you have to deal with it
- `GET /v1/models` is forwarded upstream so your front end can enumerate the models your account may use, instead of you hardcoding a list
- A preset path with a name that doesn't exist (`/v1/typo/messages`) returns 400 with the list of real presets, rather than quietly sending the request with no preset applied
- A request to Anthropic is aborted after `upstream_timeout_ms` of socket inactivity (default 300000). Streaming resets the timer, so only a genuinely stalled upstream trips it
- Optionally filter sampling parameters to avoid conflicts with Sonnet 4.5. Set `filter_sampling_params=true` in `server/config.txt` to enable this feature, which ensures only one sampling parameter is sent to the API. When both `temperature` and `top_p` are specified, it removes whichever is at the default value (1.0), or prefers temperature if both are non-default (Sonnet 4.5 doesn't allow both parameters). Other models work fine with both parameters, so this defaults to off

### Smart Host Binding
- **Native execution**: Binds to `127.0.0.1` (secure, local-only)
- **Docker container**: Automatically detects and binds to `0.0.0.0` (required for port mapping)
- **Manual override**: Set explicit `host=` value in config.txt to override auto-detection

## Mac

**Good news for Mac users!** With the new OAuth authentication, you no longer need to extract credentials from Keychain Access. Just use the standalone OAuth flow:

1. Start the server with `./run.sh`
2. Authenticate through your browser when it opens
3. Done!

### Legacy: Claude Code Credentials on Mac (Optional)
If you prefer to use Claude Code credentials as a fallback:

On Mac, Claude Code stores credentials securely in the Keychain Access app rather than as a plain text file. To extract them:
1. Open Keychain Access and search for "Claude" (reveals "Claude Code-credentials" entry)
2. Double click to open the entry > click "Show password" (authenticate with your password if asked)
3. Copy the text of the token (the json content)
4. Using your text editor of choice, create the file `~/.claude/credentials.json` and paste the token text in and save
5. Now when you access the proxy, it can parse the `~/.claude/credentials.json` file and extract what it needs

## Todo
- Implement intelligent caching to deal with SillyTavern features
- ~~Possibly auto-refreshing creds with CLI option~~ ✓ **Done! OAuth tokens refresh automatically**
