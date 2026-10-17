// Live Scene Narrator: serves the phone UI and proxies camera frames to the
// Perceptron vision-language API, streaming the description back as plain text.
// Zero dependencies. Run: PERCEPTRON_API_KEY=... node server.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

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

const SYSTEM_PROMPT =
  'You narrate the surroundings, live, for someone who may be blind or low-vision. ' +
  'Reply in 1-2 short, plain sentences, most important thing first. ' +
  'Prioritise people, obstacles, hazards, steps, doors, vehicles and readable text, with rough ' +
  'position (left / ahead / right, near / far). No preamble, no "the image shows". ' +
  'If the scene is essentially the same as the previous description, reply exactly "No change."';

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

function readJson(req, limit = 8 * 1024 * 1024) {
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

// POST /api/describe  { image: "data:image/jpeg;base64,...", previous?: string }
// Responds with a chunked text/plain stream of the description.
async function describe(req, res) {
  let body;
  try { body = await readJson(req); } catch (e) { return send(res, 400, `Bad request: ${e.message}`); }
  if (typeof body.image !== 'string' || !body.image.startsWith('data:image/')) {
    return send(res, 400, 'Expected { image: "data:image/..." }');
  }

  const previous = (body.previous || '').slice(0, 500);
  const userText = previous
    ? `Previous description: "${previous}"\nDescribe the current frame.`
    : 'Describe the current frame.';

  // Perceptron's output cap is `max_completion_tokens` (`max_tokens` is not in its schema).
  // Reasoning is explicitly off: it would delay the first word and is not needed for captions.
  const payload = {
    model: MODEL,
    stream: true,
    reasoning_effort: 'none',
    max_completion_tokens: 120,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: body.image } },
        { type: 'text', text: userText },
      ] },
    ],
  };

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

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });

  const type = upstream.headers.get('content-type') || '';
  try {
    if (type.includes('text/event-stream')) {
      // Translate OpenAI-style SSE deltas into a plain text stream.
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of upstream.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; } // keep-alives / partial junk
          if (event.error) console.error('Perceptron stream error:', JSON.stringify(event.error));
          // Final chunk may carry only usage, with no choices; reasoning_content is ignored.
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) res.write(delta);
        }
      }
    } else {
      // Streaming not honoured: return the whole message at once.
      const json = await upstream.json();
      res.write(json.choices?.[0]?.message?.content || '');
    }
  } catch (e) {
    if (!abort.signal.aborted) console.error('Stream error:', e.message);
  }
  res.end();
}

function handler(req, res) {
  if (req.method === 'POST' && req.url.startsWith('/api/describe')) return describe(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  send(res, 405, 'Method not allowed');
}

http.createServer(handler).listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`\nLive Scene Narrator  (model: ${MODEL})`);
  console.log(`  Desktop:  http://localhost:${HTTP_PORT}`);
});

const tls = ensureCert();
if (tls) {
  https.createServer(tls, handler).listen(HTTPS_PORT, '0.0.0.0', () => {
    for (const ip of lanAddresses()) console.log(`  Phone:    https://${ip}:${HTTPS_PORT}   (accept the certificate warning)`);
    console.log('');
  });
}
