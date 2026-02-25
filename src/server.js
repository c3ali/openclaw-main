const express = require('express');
const httpProxy = require('http-proxy');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_FILE = '/tmp/server.log';

function log(...args) {
  const msg = args.join(' ');
  console.log(msg);
  try {
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {
    // ignore
  }
}

log('[init] Starting OpenClaw wrapper server...');

// Configuration
const PORT = process.env.PORT || process.env.OPENCLAW_PUBLIC_PORT || 8080;
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
const WORKSPACE_DIR = path.join(STATE_DIR, 'workspace');
const INTERNAL_GATEWAY_PORT = process.env.INTERNAL_GATEWAY_PORT || 18789;
// Gateway bind CLI flag (loopback is valid for openclaw gateway)
const GATEWAY_BIND_HOST = process.env.OPENCLAW_GATEWAY_BIND || 'loopback';
// Proxy target (must be IP address, not hostname)
const GATEWAY_PROXY_HOST = process.env.OPENCLAW_GATEWAY_PROXY_HOST || '127.0.0.1';
const GATEWAY_TARGET = `http://${GATEWAY_PROXY_HOST}:${INTERNAL_GATEWAY_PORT}`;
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY || '/openclaw/dist/entry.js';

log('[init] Configuration loaded');
log('[init] PORT =', PORT);
log('[init] STATE_DIR =', STATE_DIR);
log('[init] GATEWAY_TARGET =', GATEWAY_TARGET);

// Gateway process management
let gatewayProc = null;
let gatewayStarting = false;
let gatewayReady = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureGatewayRunning() {
  if (gatewayReady && gatewayProc) return { ok: true };
  if (gatewayStarting) {
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (gatewayReady && gatewayProc) return { ok: true };
    }
    return { ok: false, reason: 'timed out waiting for gateway to start' };
  }

  gatewayStarting = true;
  gatewayReady = false;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Generate a random gateway token
  function generateToken() {
    const crypto = require('crypto');
    return crypto.randomBytes(32).toString('hex');
  }
  
  const configTimeout = (ms) => new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), ms)
  );
  
  // Configure gateway.mode=local BEFORE starting gateway (required for Railway deployment)
  log('[gateway] Configuring gateway.mode=local for Railway...');
  const modeProc = spawn('node', [
    OPENCLAW_ENTRY, 'config', 'set', 'gateway.mode', 'local'
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });
  
  try {
    await Promise.race([
      new Promise(resolve => modeProc.on('close', resolve)),
      configTimeout(10000)
    ]);
  } catch (e) {
    log('[gateway] gateway.mode config warning:', e.message);
    modeProc.kill('SIGTERM');
  }
  
  // Generate and set gateway auth token
  const gatewayAuthToken = generateToken();
  log('[gateway] Setting gateway auth token...');
  const tokenProc = spawn('node', [
    OPENCLAW_ENTRY, 'config', 'set', 'gateway.auth.token', gatewayAuthToken
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });
  
  try {
    await Promise.race([
      new Promise(resolve => tokenProc.on('close', resolve)),
      configTimeout(10000)
    ]);
  } catch (e) {
    log('[gateway] token config warning:', e.message);
    tokenProc.kill('SIGTERM');
  }
  
  log('[gateway] Configuring trustedProxies for Railway...');
  const trustProxyProc = spawn('node', [
    OPENCLAW_ENTRY, 'config', 'set', '--json', 'gateway.trustedProxies',
    '["127.0.0.1","::1","100.64.0.0/10"]'
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });
  
  try {
    await Promise.race([
      new Promise(resolve => trustProxyProc.on('close', resolve)),
      configTimeout(10000)
    ]);
  } catch (e) {
    log('[gateway] trustedProxies config warning:', e.message);
    trustProxyProc.kill('SIGTERM');
  }
  
  // Configure Control UI BEFORE starting gateway (to avoid restart)
  log('[gateway] Configuring Control UI for Railway...');
  const controlUiProc = spawn('node', [
    OPENCLAW_ENTRY, 'config', 'set', '--json', 'gateway.controlUi',
    '{"allowedOrigins":["*"],"allowInsecureAuth":true,"dangerouslyDisableDeviceAuth":true}'
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });
  
  try {
    await Promise.race([
      new Promise(resolve => controlUiProc.on('close', resolve)),
      configTimeout(10000)
    ]);
  } catch (e) {
    log('[gateway] Control UI config warning:', e.message);
    controlUiProc.kill('SIGTERM');
  }

  const args = [
    OPENCLAW_ENTRY,
    'gateway', 'run',
    '--bind', GATEWAY_BIND_HOST,
    '--port', String(INTERNAL_GATEWAY_PORT)
  ];

  log('[gateway] Starting:', 'node', args.join(' '));

  gatewayProc = spawn('node', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENCLAW_DATA: STATE_DIR,
      OPENCLAW_WORKSPACE: WORKSPACE_DIR,
    },
  });

  gatewayProc.stdout.on('data', (d) => process.stdout.write(d));
  gatewayProc.stderr.on('data', (d) => process.stderr.write(d));

  gatewayProc.on('error', (err) => {
    log('[gateway] error:', err);
    gatewayStarting = false;
    gatewayReady = false;
    gatewayProc = null;
  });

  gatewayProc.on('close', (code, signal) => {
    log(`[gateway] exited: code=${code}, signal=${signal}`);
    gatewayStarting = false;
    gatewayReady = false;
    gatewayProc = null;
    setTimeout(() => ensureGatewayRunning(), 5000);
  });

  // Store the generated token for WebSocket injection
  gatewayToken = gatewayAuthToken;
  log('[gateway] Using generated token:', gatewayToken.substring(0, 8) + '...');

  // Wait for gateway to be ready
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const res = await fetch(`${GATEWAY_TARGET}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        gatewayReady = true;
        log('[gateway] Ready!');
        return { ok: true };
      }
    } catch {
      // ignore
    }
  }
  gatewayReady = false;
  return { ok: false, reason: 'timed out waiting for gateway to start' };
}

function configPath() {
  return path.join(STATE_DIR, 'openclaw.json');
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

// Express app
const app = express();
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'healthy', configured: isConfigured() });
});

// Root - redirect to setup or proxy to gateway
app.get('/', async (req, res) => {
  if (!isConfigured()) {
    return res.redirect('/setup');
  }
  // If configured, proxy to gateway
  const result = await ensureGatewayRunning();
  if (!result.ok) {
    return res.status(503).send('Gateway not ready: ' + result.reason);
  }
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

// Setup page
app.get('/setup', (req, res) => {
  if (isConfigured()) {
    return res.redirect('/');
  }

  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline'");
  res.type('text/html; charset=utf-8');
  res.send(`
<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenClaw Setup</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; line-height: 1.6; color: #333; }
  h1 { margin-bottom: 20px; }
  h2 { margin-top: 25px; margin-bottom: 15px; color: #555; }
  label { display: block; margin-bottom: 5px; font-weight: 600; }
  input, select { width: 100%; padding: 8px; margin-bottom: 15px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
  select { background: white; cursor: pointer; }
  button { background: #0066cc; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 16px; }
  button:hover { background: #0055aa; }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  .error { background: #fee; color: #c00; padding: 10px; border-radius: 4px; margin-bottom: 15px; }
  .status { background: #e7f3ff; padding: 10px; border-radius: 4px; margin-bottom: 15px; }
  .hidden { display: none; }
  .hint { font-size: 12px; color: #666; margin-top: -10px; margin-bottom: 15px; }
  .provider-section { background: #f9f9f9; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
</style>
</head>
<body>
<h1>Configuration OpenClaw</h1>
<p>Configurez votre instance OpenClaw en quelques secondes.</p>

<form id="setup-form">
  <div id="error" class="error hidden"></div>
  <div id="status" class="status hidden"></div>

  <div class="provider-section">
    <h2>Fournisseur LLM</h2>
    
    <label for="provider">Fournisseur API</label>
    <select id="provider" onchange="toggleProviderFields()">
      <option value="openai">OpenAI (officiel)</option>
      <option value="nanogpt">NanoGPT (OpenAI + Anthropic)</option>
      <option value="openrouter">OpenRouter</option>
      <option value="custom">Autre (compatible OpenAI)</option>
    </select>

    <div id="baseUrlField" class="hidden">
      <label for="baseUrl">URL de base API</label>
      <input type="url" id="baseUrl" placeholder="https://nano-gpt.com/api/v1">
      <div class="hint">NanoGPT fournit les modeles OpenAI et Anthropic via une seule API</div>
    </div>

    <label for="apiKey">Cle API (requis)</label>
    <input type="password" id="apiKey" placeholder="sk-..." required>
    <div id="apiKeyHint" class="hint">Votre cle API OpenAI commence par "sk-"</div>
  </div>

  <h2>Canaux optionnels</h2>

  <label for="telegramBotToken">Token Bot Telegram (optionnel)</label>
  <input type="text" id="telegramBotToken" placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz">

  <label for="discordBotToken">Token Bot Discord (optionnel)</label>
  <input type="password" id="discordBotToken" placeholder="MTIzNDU2Nzg5...">

  <button type="submit" id="submit-btn">Enregistrer la configuration</button>
</form>

<script>
const form = document.getElementById("setup-form");
const error = document.getElementById("error");
const status = document.getElementById("status");
const submitBtn = document.getElementById("submit-btn");

const providerUrls = {
  openai: "",
  nanogpt: "https://nano-gpt.com/api/v1",
  openrouter: "https://openrouter.ai/api/v1",
  custom: ""
};

const providerHints = {
  openai: "Votre cle API OpenAI commence par sk-",
  nanogpt: "Votre cle API NanoGPT - acces aux modeles OpenAI et Anthropic",
  openrouter: "Votre cle API OpenRouter",
  custom: "Votre cle API pour ce fournisseur"
};

function toggleProviderFields() {
  const provider = document.getElementById("provider").value;
  const baseUrlField = document.getElementById("baseUrlField");
  const baseUrlInput = document.getElementById("baseUrl");
  const apiKeyHint = document.getElementById("apiKeyHint");
  
  if (provider === "openai") {
    baseUrlField.classList.add("hidden");
    baseUrlInput.value = "";
  } else {
    baseUrlField.classList.remove("hidden");
    baseUrlInput.value = providerUrls[provider] || "";
    baseUrlInput.placeholder = provider === "custom" ? "https://votre-api.com/v1" : providerUrls[provider];
  }
  
  apiKeyHint.textContent = providerHints[provider] || providerHints.custom;
}

function showError(msg) {
  error.textContent = msg;
  error.classList.remove("hidden");
}

function hideError() {
  error.classList.add("hidden");
}

function showStatus(msg) {
  status.textContent = msg;
  status.classList.remove("hidden");
}

function hideStatus() {
  status.classList.add("hidden");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();
  submitBtn.disabled = true;
  showStatus("Configuration en cours...");

  const provider = document.getElementById("provider").value;
  const baseUrl = document.getElementById("baseUrl").value.trim();
  const apiKey = document.getElementById("apiKey").value.trim();
  const telegramBotToken = document.getElementById("telegramBotToken").value.trim();
  const discordBotToken = document.getElementById("discordBotToken").value.trim();

  if (!apiKey) {
    showError("La cle API est requise");
    submitBtn.disabled = false;
    return;
  }

  if (provider !== "openai" && !baseUrl) {
    showError("L'URL de base est requise pour ce fournisseur");
    submitBtn.disabled = false;
    return;
  }

  const payload = {
    provider,
    baseUrl: provider === "openai" ? "" : baseUrl,
    apiKey,
    telegramBotToken,
    discordBotToken,
  };

  try {
    const r = await fetch("/setup/api/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!j.ok) {
      showError(j.error || "Erreur inconnue");
      submitBtn.disabled = false;
    } else {
      showStatus("Configuration enregistree ! Redirection...");
      setTimeout(() => {
        window.location.href = "/";
      }, 2000);
    }
  } catch (err) {
    showError(err.toString());
    submitBtn.disabled = false;
  }
});
</script>
</body>
</html>
  `);
});

// Setup API endpoint
app.post('/setup/api/configure', async (req, res) => {
  try {
    const { provider, baseUrl, apiKey, telegramBotToken, discordBotToken } = req.body || {};

    if (!apiKey?.trim()) {
      return res.status(400).json({ ok: false, error: 'La cle API est requise' });
    }

    if (provider !== 'openai' && !baseUrl?.trim()) {
      return res.status(400).json({ ok: false, error: "L'URL de base est requise pour ce fournisseur" });
    }

    // Configure provider based on selection
    if (provider === 'nanogpt') {
      const nanogptUrl = baseUrl.trim() || 'https://nano-gpt.com/api/v1';
      
      log('[setup] Configuring NanoGPT provider with URL:', nanogptUrl);
      
      const openaiConfig = { 
        apiKey: apiKey.trim(),
        baseUrl: nanogptUrl
      };
      const openaiProc = spawn('node', [
        OPENCLAW_ENTRY, 'config', 'set', '--json', 'providers.openai',
        JSON.stringify(openaiConfig)
      ], {
        stdio: 'pipe',
        env: process.env
      });
      await new Promise(resolve => openaiProc.on('close', resolve));
      
      const anthropicConfig = { 
        apiKey: apiKey.trim(),
        baseUrl: nanogptUrl
      };
      const anthropicProc = spawn('node', [
        OPENCLAW_ENTRY, 'config', 'set', '--json', 'providers.anthropic',
        JSON.stringify(anthropicConfig)
      ], {
        stdio: 'pipe',
        env: process.env
      });
      await new Promise(resolve => anthropicProc.on('close', resolve));
      
      const defaultModelProc = spawn('node', [
        OPENCLAW_ENTRY, 'config', 'set', 'agents.defaults.model.primary',
        'openai/gpt-4o-mini'
      ], {
        stdio: 'pipe',
        env: process.env
      });
      await new Promise(resolve => defaultModelProc.on('close', resolve));
      
    } else if (provider === 'openrouter') {
      const openrouterUrl = baseUrl.trim() || 'https://openrouter.ai/api/v1';
      
      const configProc = spawn('node', [
        OPENCLAW_ENTRY, 'config', 'set', '--json', 'providers.openrouter',
        JSON.stringify({ apiKey: apiKey.trim(), baseUrl: openrouterUrl })
      ], {
        stdio: 'pipe',
        env: process.env
      });
      await new Promise(resolve => configProc.on('close', resolve));
      
      const defaultModelProc = spawn('node', [
        OPENCLAW_ENTRY, 'config', 'set', 'agents.defaults.model.primary',
        'openrouter/openai/gpt-4o-mini'
      ], {
        stdio: 'pipe',
        env: process.env
      });
      await new Promise(resolve => defaultModelProc.on('close', resolve));
      
    } else if (provider === 'custom') {
      const customConfig = { 
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim()
      };
      const configProc = spawn('node', [
        OPENCLAW_ENTRY, 'config', 'set', '--json', 'providers.openai',
        JSON.stringify(customConfig)
      ], {
        stdio: 'pipe',
        env: process.env
      });
      await new Promise(resolve => configProc.on('close', resolve));
      
    } else {
      const configProc = spawn('node', [
        OPENCLAW_ENTRY, 'config', 'set', '--json', 'providers.openai',
        JSON.stringify({ apiKey: apiKey.trim() })
      ], {
        stdio: 'pipe',
        env: process.env
      });
      await new Promise(resolve => configProc.on('close', resolve));
    }

    // Configure Telegram if provided
    if (telegramBotToken?.trim()) {
      const tgProc = spawn('node', [
        OPENCLAW_ENTRY, 'config', 'set', '--json', 'channels.telegram',
        JSON.stringify({ botToken: telegramBotToken.trim() })
      ], {
        stdio: 'pipe',
        env: process.env
      });
      await new Promise(resolve => tgProc.on('close', resolve));
    }

    // Configure Discord if provided
    if (discordBotToken?.trim()) {
      const dcProc = spawn('node', [
        OPENCLAW_ENTRY, 'config', 'set', '--json', 'channels.discord',
        JSON.stringify({ botToken: discordBotToken.trim() })
      ], {
        stdio: 'pipe',
        env: process.env
      });
      await new Promise(resolve => dcProc.on('close', resolve));
    }

    // Restart gateway
    if (gatewayProc) {
      gatewayProc.kill('SIGTERM');
      await sleep(750);
      gatewayProc = null;
      gatewayReady = false;
    }
    await ensureGatewayRunning();

    res.json({ ok: true, provider: provider });
  } catch (err) {
    log('[setup] Error:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Token will be read from gateway config after startup
let gatewayToken = null;

// Proxy to gateway
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on('error', (err, req, res) => {
  log('[proxy] error:', err);
  if (res && typeof res.status === 'function' && !res.headersSent) {
    res.status(502).send('Bad Gateway');
  }
});

// Main route - proxy to gateway or show setup
app.use(async (req, res, next) => {
  if (!isConfigured() && !req.path.startsWith('/setup')) {
    return res.redirect('/setup');
  }

  if (isConfigured()) {
    if (gatewayStarting && !gatewayReady) {
      return res.status(503).send('Gateway starting... Please retry in a moment.');
    }
    const result = await ensureGatewayRunning();
    if (!result.ok) {
      return res.status(503).send('Gateway not ready: ' + result.reason);
    }
    return proxy.web(req, res, { target: GATEWAY_TARGET });
  }

  next();
});

// WebSocket upgrade with token injection
const server = app.listen(PORT, '0.0.0.0', () => {
  log('[server] Listening on port', PORT);
  log('[server] Ready! Access at http://localhost:' + PORT);
});

// Custom WebSocket proxy that injects token into connect message
const WebSocket = require('ws');
const wss = new WebSocket.Server({ noServer: true });

// Handle upgrade requests
server.on('upgrade', async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }

  // Handle WebSocket upgrade
  wss.handleUpgrade(req, socket, head, (ws) => {
    const gatewayUrl = `ws://127.0.0.1:${INTERNAL_GATEWAY_PORT}`;
    
    const clientOrigin = req.headers.origin || req.headers['sec-websocket-origin'];
    const clientHost = req.headers.host;
    
    const gatewayWs = new WebSocket(gatewayUrl, {
      headers: {
        'origin': clientOrigin || '',
        'host': '127.0.0.1:18789',
        'x-forwarded-origin': clientOrigin || '',
        'x-forwarded-host': clientHost || '',
      }
    });
    
    let gatewayReady = false;
    let clientMessageQueue = [];
    
    gatewayWs.on('open', () => {
      log('[ws-proxy] Connected to gateway');
      gatewayReady = true;
      while (clientMessageQueue.length > 0) {
        const data = clientMessageQueue.shift();
        try {
          gatewayWs.send(data);
        } catch {
          // ignore
        }
      }
    });
    
    gatewayWs.on('message', (data) => {
      try {
        const msgStr = data.toString();
        try {
          const msg = JSON.parse(msgStr);
          if (msg.type === 'event') {
            if (msg.event === 'connect.challenge') {
              log('[ws-proxy] Gateway event: connect.challenge nonce=', msg.payload?.nonce ? 'present' : 'missing');
            } else {
              log('[ws-proxy] Gateway event:', msg.event, 'seq=', msg.seq);
            }
          } else if (msg.type === 'res') {
            if (msg.ok) {
              log('[ws-proxy] Gateway response ok id=', msg.id, 'payload type=', msg.payload?.type || 'unknown');
            } else {
              log('[ws-proxy] Gateway response error id=', msg.id, 'error=', msg.error?.message || msg.error);
            }
          }
        } catch {
          // ignore parse errors
        }
        if (ws.readyState === 1) {
          ws.send(data);
        }
      } catch (e) {
        log('[ws-proxy] Error forwarding to client:', e.message);
      }
    });
    
    gatewayWs.on('close', () => {
      try { ws.close(); } catch { /* ignore */ }
    });
    
    gatewayWs.on('error', (err) => {
      log('[ws-proxy] Gateway error:', err.message);
      try { ws.close(); } catch { /* ignore */ }
    });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'req' && msg.method === 'connect') {
          log('[ws-proxy] Client connect message received');
          
          if (!msg.params) msg.params = {};
          if (!msg.params.auth) msg.params.auth = {};
          
          // Inject token if no auth provided
          if (!msg.params.auth.token && gatewayToken) {
            msg.params.auth.token = gatewayToken;
            log('[ws-proxy] Injected token into connect message');
          }
          
          // Remove device if nonce is empty and we have token (for token auth)
          const deviceNonce = msg.params?.device?.nonce;
          const hasDevice = !!msg.params?.device;
          const nonceEmpty = !deviceNonce || (typeof deviceNonce === 'string' && deviceNonce.trim() === '');
          
          if (hasDevice && nonceEmpty && gatewayToken) {
            delete msg.params.device;
            log('[ws-proxy] Removed device for token auth');
          }
        }
        
        const processedData = JSON.stringify(msg);
        
        if (!gatewayReady) {
          clientMessageQueue.push(processedData);
        } else {
          gatewayWs.send(processedData);
        }
      } catch {
        if (!gatewayReady) {
          clientMessageQueue.push(data);
        } else {
          gatewayWs.send(data);
        }
      }
    });
    
    ws.on('close', (code, reason) => {
      log('[ws-proxy] Client disconnected code=', code);
      try { gatewayWs.close(); } catch { /* ignore */ }
    });
    
    ws.on('error', (err) => {
      log('[ws-proxy] Client error:', err.message);
      try { gatewayWs.close(); } catch { /* ignore */ }
    });
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('[server] SIGTERM received');
  if (gatewayProc) {
    gatewayProc.kill('SIGTERM');
  }
  process.exit(0);
});

log('[init] Server initialized');
