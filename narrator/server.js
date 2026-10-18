// Live Scene Narrator: serves the phone UI, proxies camera frames to the Perceptron
// vision-language API, and proxies alert text to ElevenLabs text-to-speech. API keys stay here.
// Zero dependencies. Run: PERCEPTRON_API_KEY=... [ELEVENLABS_API_KEY=...] node server.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const { buildPayload } = require('./prompt');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CERTS = path.join(ROOT, 'certs');
const HTTP_PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const API_URL = 'https://api.perceptron.inc/v1/chat/completions';
const MODEL = process.env.PERCEPTRON_MODEL || 'perceptron-mk1.5';

loadDotEnv();
const API_KEY = process.env.PERCEPTRON_API_KEY;
if (!API_KEY) {
  console.error('Missing PERCEPTRON_API_KEY. Set it in the environment or in narrator/.env');
  console.error('Get a key at https://platform.perceptron.inc/');
  process.exit(1);
}

// Speech is optional: without a key, /api/speak answers 503 and the page stays silent.
// eleven_v4_turbo: ElevenLabs' most realistic real-time model (~100 ms inference). The
// voice is a default (premade) one, which ElevenLabs lists among the fastest kinds.
const TTS_KEY = process.env.ELEVENLABS_API_KEY;
const TTS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_v4_turbo';
const TTS_VOICE = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
const TTS_FORMAT = process.env.ELEVENLABS_FORMAT || 'mp3_44100_128';
const TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(TTS_VOICE)}/stream?output_format=${TTS_FORMAT}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

// Self-signed cert so phones on the LAN get a secure context (required for camera access).
function ensureCert() {
  const key = path.join(CERTS, 'key.pem');
  const cert = path.join(CERTS, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(CERTS, { recursive: true });
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map((ip) => `IP:${ip}`)].join(',');
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365',
        '-keyout', key, '-out', cert, '-subj', '/CN=narrator.local', '-addext', `subjectAltName=${san}`,
      ], { stdio: 'ignore' });
    } catch (e) {
      console.warn('Could not create a self-signed cert with openssl; HTTPS disabled.');
      return null;
    }
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readJson(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Payload too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// POST /api/describe  { image, prevImage?, prevDtMs?, said?: string[] }  (images as data URLs)
// Responds with text/plain: the model's reply (a short alert, or "n/a"). The browser decides
// whether it is new enough to show. Server-Timing reports how long Perceptron took.
async function describe(req, res) {
  let payload;
  try { payload = buildPayload(await readJson(req), MODEL); } catch (e) { return send(res, 400, `Bad request: ${e.message}`); }
  const t0 = performance.now();

  const abort = new AbortController();
  res.on('close', () => abort.abort());

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
  } catch (e) {
    if (abort.signal.aborted) return;
    return send(res, 502, `Upstream error: ${e.message}`);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    console.error(`Perceptron ${upstream.status}: ${text.slice(0, 500)}`);
    // Pass rate-limit / overload back so the client can back off (honouring Retry-After).
    const status = upstream.status === 429 || upstream.status === 503 ? upstream.status : 502;
    const retryAfter = upstream.headers.get('retry-after');
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...(retryAfter && { 'Retry-After': retryAfter }) });
    return res.end(`Perceptron API ${upstream.status}: ${text.slice(0, 300)}`);
  }

  let json;
  try {
    json = await upstream.json();
  } catch (e) {
    if (abort.signal.aborted) return;
    return send(res, 502, `Bad upstream response: ${e.message}`);
  }
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Server-Timing': `api;dur=${Math.round(performance.now() - t0)}`,
  });
  res.end((json.choices?.[0]?.message?.content || '').trim());
}

// POST /api/speak  { text }  ->  audio/mpeg, streamed through from ElevenLabs as it is generated.
// Server-Timing reports ElevenLabs' time to first byte.
async function speak(req, res) {
  if (!TTS_KEY) return send(res, 503, 'Voice is off: set ELEVENLABS_API_KEY in narrator/.env');
  let text;
  try { text = String((await readJson(req, 64 * 1024)).text || '').trim().slice(0, 500); } catch (e) { return send(res, 400, `Bad request: ${e.message}`); }
  if (!text) return send(res, 400, 'Expected { text }');

  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const t0 = performance.now();
  let upstream;
  try {
    upstream = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'xi-api-key': TTS_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: TTS_MODEL, language_code: 'en' }),
      signal: abort.signal,
    });
  } catch (e) {
    if (abort.signal.aborted) return;
    return send(res, 502, `ElevenLabs error: ${e.message}`);
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error(`ElevenLabs ${upstream.status}: ${detail.slice(0, 500)}`);
    const status = upstream.status === 429 ? 429 : 502;
    return send(res, status, `ElevenLabs ${upstream.status}: ${detail.slice(0, 300)}`);
  }

  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
    'Cache-Control': 'no-store',
    'Server-Timing': `tts;dur=${Math.round(performance.now() - t0)}`,
  });
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (e) {
    if (!abort.signal.aborted) console.error('ElevenLabs stream error:', e.message);
  }
  res.end();
}

function handler(req, res) {
  if (req.method === 'POST' && req.url.startsWith('/api/describe')) return describe(req, res);
  if (req.method === 'POST' && req.url.startsWith('/api/speak')) return speak(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  send(res, 405, 'Method not allowed');
}

http.createServer(handler).listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`\nLive Scene Narrator  (model: ${MODEL})`);
  console.log(TTS_KEY
    ? `  Voice:    ElevenLabs ${TTS_MODEL}, voice ${TTS_VOICE}, ${TTS_FORMAT}`
    : '  Voice:    off (set ELEVENLABS_API_KEY in narrator/.env to enable)');
  console.log(`  Desktop:  http://localhost:${HTTP_PORT}`);
});

const tls = ensureCert();
if (tls) {
  https.createServer(tls, handler).listen(HTTPS_PORT, '0.0.0.0', () => {
    for (const ip of lanAddresses()) console.log(`  Phone:    https://${ip}:${HTTPS_PORT}   (accept the certificate warning)`);
    console.log('');
  });
}
