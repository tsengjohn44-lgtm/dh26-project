// Live Scene Narrator: serves the phone UI and proxies camera frames to the
// Perceptron vision-language API, streaming the description back as plain text.
// Zero dependencies. Run: PERCEPTRON_API_KEY=... node server.js

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
// EVAL=1 also serves the evaluation pages in eval/ at /eval/, and test images from the folder
// in EVAL_IMAGES at /eval/images/ (kept out of git). Off by default so the demo server is unchanged.
const EVAL = process.env.EVAL === '1';
const EVAL_DIR = path.join(ROOT, 'eval');
const EVAL_IMAGES = process.env.EVAL_IMAGES ? path.resolve(process.env.EVAL_IMAGES) : null;
const IMAGE_FILE = /\.(jpe?g|png)$/i;

loadDotEnv();
const API_KEY = process.env.PERCEPTRON_API_KEY;
if (!API_KEY) {
  console.error('Missing PERCEPTRON_API_KEY. Set it in the environment or in narrator/.env');
  console.error('Get a key at https://platform.perceptron.inc/');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
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
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, 'Bad path'); }
  if (EVAL && urlPath === '/eval/images/') return listImages(res);
  if (EVAL && EVAL_IMAGES && urlPath.startsWith('/eval/images/')) return serveFile(res, EVAL_IMAGES, urlPath.slice('/eval/images'.length));
  if (EVAL && urlPath.startsWith('/eval/')) return serveFile(res, EVAL_DIR, urlPath.slice('/eval'.length));
  serveFile(res, PUBLIC, urlPath === '/' ? '/index.html' : urlPath);
}

// Serves root + urlPath. The separator check also rejects siblings such as "public2" that a
// plain startsWith(root) would let through (an encoded "..%2F" survives URL normalisation).
function serveFile(res, root, urlPath) {
  const file = path.normalize(path.join(root, urlPath));
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// JSON list of test image file names, so eval pages can find them without a hard-coded list.
function listImages(res) {
  const names = EVAL_IMAGES && fs.existsSync(EVAL_IMAGES) ? fs.readdirSync(EVAL_IMAGES).filter((f) => IMAGE_FILE.test(f)).sort() : [];
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(names));
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

function handler(req, res) {
  if (req.method === 'POST' && req.url.startsWith('/api/describe')) return describe(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  send(res, 405, 'Method not allowed');
}

http.createServer(handler).listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`\nLive Scene Narrator  (model: ${MODEL})`);
  console.log(`  Desktop:  http://localhost:${HTTP_PORT}`);
  if (EVAL) console.log(`  Eval:     http://localhost:${HTTP_PORT}/eval/bench.html   (images: ${EVAL_IMAGES || 'none, set EVAL_IMAGES'})`);
});

const tls = ensureCert();
if (tls) {
  https.createServer(tls, handler).listen(HTTPS_PORT, '0.0.0.0', () => {
    for (const ip of lanAddresses()) console.log(`  Phone:    https://${ip}:${HTTPS_PORT}   (accept the certificate warning)`);
    console.log('');
  });
}
