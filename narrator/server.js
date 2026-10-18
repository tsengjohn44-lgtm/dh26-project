// Live Scene Narrator: serves the phone UI, proxies camera frames to the Perceptron
// vision-language API, and proxies alert text to ElevenLabs text-to-speech. API keys stay here.
// Zero dependencies. Run: PERCEPTRON_API_KEY=... [ELEVENLABS_API_KEY=...] node server.js

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const { buildPayload, buildAskPayload } = require('./prompt');
const Filter = require('./public/filter.js');

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
// Raw 16-bit PCM so the browser can play each chunk as it arrives (MP3 had to be fully
// downloaded and decoded first: ~0.9 s vs ~0.2 s to first audio). 44100 needs the Pro tier.
const TTS_RATE = Number(process.env.ELEVENLABS_SAMPLE_RATE || 24000);
const TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(TTS_VOICE)}/stream?output_format=pcm_${TTS_RATE}`;
// Faster delivery. v3/v4 models ignore voice_settings.speed (measured: same length at 1.0-1.5)
// but follow an audio tag, which isn't spoken. Measured on 3 alerts with v4 Turbo: no tag
// 10.16 s, [speaking quickly] 8.32 s, [rapidly] 7.44 s. Other models (e.g. Flash v2.5) use
// voice_settings.speed instead, max 1.2 (ElevenLabs rejects higher): 6.46 s at 1.2.
const TTS_SPEED = Number(process.env.ELEVENLABS_SPEED || 1.2);
const TTS_TAG = /^eleven_v[34]/.test(TTS_MODEL) ? (process.env.ELEVENLABS_TAG ?? '[rapidly]') : '';

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
// The Mac's Bonjour name (e.g. NoozMBP.local): phones on the same Wi-Fi can open
// https://<name>.local:8443 instead of an IP that changes.
function localHostname() {
  const h = os.hostname().replace(/\.local$/i, '').split('.')[0];
  return h ? `${h}.local` : null;
}

function ensureCert() {
  const key = path.join(CERTS, 'key.pem');
  const cert = path.join(CERTS, 'cert.pem');
  const mdnsName = localHostname();
  // Rebuild a certificate that doesn't name this Mac's .local address. Not rebuilt when the IP
  // changes: the phone would have to accept a new certificate warning every time.
  const missingName = fs.existsSync(cert) && mdnsName
    && !(() => { try { return new crypto.X509Certificate(fs.readFileSync(cert)).subjectAltName.includes(`DNS:${mdnsName}`); } catch { return false; } })();
  if (!fs.existsSync(key) || !fs.existsSync(cert) || missingName) {
    fs.mkdirSync(CERTS, { recursive: true });
    const san = ['DNS:localhost', ...(mdnsName ? [`DNS:${mdnsName}`] : []), 'IP:127.0.0.1', ...lanAddresses().map((ip) => `IP:${ip}`)].join(',');
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
// POST /api/ask uses the same path with { ask: true }: body { image, audio (base64 WAV), reasoning? },
// the spoken question answered about the current frame (prompt.js buildAskPayload).
async function describe(req, res, { ask = false } = {}) {
  let body, payload;
  try {
    body = await readJson(req);
    payload = ask ? buildAskPayload(body, MODEL) : buildPayload(body, MODEL);
  } catch (e) {
    return send(res, 400, `Bad request: ${e.message}`);
  }
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
  const reply = (json.choices?.[0]?.message?.content || '').trim();
  // Same decision the phone will make (public/filter.js); if it will be a new alert, start
  // generating its speech now. The phone's `said` may be newer, so it can still skip it.
  // An answer to a question is always spoken (not repeat-filtered), as the phone sends it.
  const alert = ask
    ? Filter.fixStairLabel(Filter.cautiousStairCount(reply.replace(/\s+/g, ' ').trim())) // exactly what the phone will say
    : Filter.classifyReply(reply, Array.isArray(body.said) ? body.said : []).text;
  if (alert) startEarlySpeech(alert);
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Server-Timing': `api;dur=${Math.round(performance.now() - t0)}`,
  });
  res.end(reply);
}

// POST /api/speak  { text }  ->  raw 16-bit little-endian mono PCM at X-Sample-Rate, streamed
// through from ElevenLabs as it is generated. Server-Timing reports ElevenLabs' time to first byte.
async function speak(req, res) {
  if (!TTS_KEY) return send(res, 503, 'Voice is off: set ELEVENLABS_API_KEY in narrator/.env');
  let text;
  try { text = String((await readJson(req, 64 * 1024)).text || '').trim().slice(0, 500); } catch (e) { return send(res, 400, `Bad request: ${e.message}`); }
  if (!text) return send(res, 400, 'Expected { text }');

  const job = takeEarlySpeech(text) || startSpeech(text);
  res.on('close', () => { if (!job.done) job.abort.abort(); });
  await job.responded;
  if (job.status !== 200) {
    if (job.abort.signal.aborted) return;
    console.error(`ElevenLabs ${job.status || 'error'}: ${job.error.slice(0, 500)}`);
    return send(res, job.status === 429 ? 429 : 502, `ElevenLabs ${job.status || 'error'}: ${job.error.slice(0, 300)}`);
  }

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'X-Sample-Rate': String(TTS_RATE),
    'X-Speech-Early': job.early ? '1' : '0',
    'Cache-Control': 'no-store',
    'Server-Timing': `tts;dur=${job.ttfb}`,
  });
  res.flushHeaders();
  // Replay what an early job already buffered, then follow it live.
  for (let i = 0; ; ) {
    while (i < job.chunks.length) res.write(job.chunks[i++]);
    if (job.done) break;
    await job.more();
  }
  res.end();
}

// One ElevenLabs generation. Chunks are buffered as they arrive so a request started early
// (see describe) can be picked up later by /api/speak without losing the start of the audio.
function startSpeech(text) {
  const job = { text, chunks: [], done: false, status: 0, error: '', ttfb: 0, early: false, abort: new AbortController(), waiters: [] };
  const wake = () => { const w = job.waiters; job.waiters = []; w.forEach((fn) => fn()); };
  job.more = () => new Promise((resolve) => job.waiters.push(resolve));
  let responded;
  job.responded = new Promise((resolve) => { responded = resolve; });
  const t0 = performance.now();
  (async () => {
    try {
      const upstream = await fetch(TTS_URL, {
        method: 'POST',
        headers: { 'xi-api-key': TTS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: TTS_TAG ? `${TTS_TAG} ${text}` : text,
          model_id: TTS_MODEL,
          language_code: 'en',
          voice_settings: { speed: TTS_SPEED },
        }),
        signal: job.abort.signal,
      });
      job.ttfb = Math.round(performance.now() - t0);
      job.status = upstream.status;
      if (!upstream.ok) { job.error = await upstream.text().catch(() => ''); return; }
      responded();
      for await (const chunk of upstream.body) { job.chunks.push(chunk); wake(); }
    } catch (e) {
      if (!job.abort.signal.aborted) { job.error = job.error || e.message; console.error('ElevenLabs stream error:', e.message); }
    } finally {
      job.done = true;
      responded();
      wake();
    }
  })();
  return job;
}

// Early speech: when describe() gets a reply that would be shown as a new alert, it starts the
// ElevenLabs request right away instead of waiting for the phone to receive the reply and ask
// for audio, which saves a phone-laptop round trip. The phone runs the same filter, so it
// usually asks for exactly this text; unclaimed jobs are dropped after EARLY_TTL_MS.
const EARLY_SPEECH = TTS_KEY && process.env.ELEVENLABS_EARLY !== '0';
const EARLY_MAX = 2;          // concurrent early generations, to stay within ElevenLabs' limit
const EARLY_TTL_MS = 15000;
const earlySpeech = new Map(); // text -> { job, timer }

function startEarlySpeech(text) {
  if (!EARLY_SPEECH || earlySpeech.has(text)) return;
  const busy = [...earlySpeech.values()].filter((e) => !e.job.done).length;
  if (busy >= EARLY_MAX) return;
  const job = startSpeech(text);
  job.early = true;
  const timer = setTimeout(() => { earlySpeech.delete(text); job.abort.abort(); }, EARLY_TTL_MS);
  earlySpeech.set(text, { job, timer });
}

function takeEarlySpeech(text) {
  const entry = earlySpeech.get(text);
  if (!entry) return null;
  earlySpeech.delete(text);
  clearTimeout(entry.timer);
  return entry.job;
}

// ---------- distance sensor (ESP8266) ----------
// The ESP8266 POSTs `distance=<metres>` or `distance=Out_of_Range` (form-encoded) about every
// 200 ms. The latest reading is pushed to every open phone over Server-Sent Events, where
// public/beeper.js turns it into proximity beeps.
let lastDistance = null;            // { metres: number|null, at: epoch ms }
const distanceClients = new Set();  // open SSE responses

function readText(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('Payload too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// POST /distance  distance=0.420 | distance=Out_of_Range  ->  204
async function postDistance(req, res) {
  let params, value;
  try { params = new URLSearchParams(await readText(req)); value = params.get('distance'); } catch (e) { return send(res, 400, e.message); }
  let metres;
  if (value === 'Out_of_Range') metres = null;
  else if (value !== null && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0) metres = Number(value);
  else return send(res, 400, 'Expected distance=<metres> or distance=Out_of_Range');
  lastDistance = { metres, at: Date.now() };
  noteEspHealth(params);
  const event = `data: ${JSON.stringify(lastDistance)}\n\n`;
  for (const client of distanceClients) client.write(event);
  res.writeHead(204);
  res.end();
}

// Board health, for debugging dropouts. The sketch sends uptime (ms since boot), rssi (Wi-Fi
// signal, dBm), drops (Wi-Fi disconnects since boot) and reset (why it last booted) with each
// reading. Logged: first contact, going silent, coming back (rebooted = power problem; same
// uptime = Wi-Fi problem), Wi-Fi drops, and a summary every 30 s. Older sketches without
// these fields still work; only silence is logged for them.
const ESP_SILENT_MS = 3000;
const esp = { lastPost: 0, uptime: null, drops: null, rssi: null, reset: '', silentSince: 0, count: 0, summaryAt: 0 };
const clock = () => new Date().toLocaleTimeString();

function noteEspHealth(params) {
  const now = Date.now();
  const uptime = params.has('uptime') ? Number(params.get('uptime')) : null;
  const drops = params.has('drops') ? Number(params.get('drops')) : null;
  const rssi = params.has('rssi') ? Number(params.get('rssi')) : null;
  const reset = params.get('reset') || '';
  const rebooted = uptime !== null && esp.uptime !== null && uptime < esp.uptime;
  const signal = rssi !== null ? `, signal ${rssi} dBm${rssi < -75 ? ' (weak)' : ''}` : '';

  if (!esp.lastPost) {
    console.log(`  [${clock()}] ESP8266 connected${uptime !== null ? ` (running ${(uptime / 1000).toFixed(0)} s, last reset: ${reset || '?'})` : ''}${signal}`);
  } else if (esp.silentSince) {
    const gap = ((now - esp.lastPost) / 1000).toFixed(1);
    if (uptime === null) console.log(`  [${clock()}] ESP8266 back after ~${gap} s${signal}`);
    else if (rebooted) console.log(`  [${clock()}] ESP8266 back after ~${gap} s: it REBOOTED (reset reason: ${reset || '?'}). Likely a power problem: supply sagging under Wi-Fi load, or wrong supply pin.`);
    else console.log(`  [${clock()}] ESP8266 back after ~${gap} s: no reboot (running ${(uptime / 1000).toFixed(0)} s), so power held; Wi-Fi/network dropped${drops !== null ? ` (Wi-Fi drops since boot: ${drops})` : ''}.`);
  } else if (rebooted) {
    console.log(`  [${clock()}] ESP8266 REBOOTED without going silent (reset reason: ${reset || '?'}, was running ${(esp.uptime / 1000).toFixed(0)} s). Likely a power dip.`);
  }
  if (drops !== null && esp.drops !== null && !rebooted && drops > esp.drops) {
    console.log(`  [${clock()}] ESP8266 reports Wi-Fi drop #${drops}${signal}`);
  }

  esp.count++;
  if (now - esp.summaryAt >= 30000) {
    if (esp.summaryAt) console.log(`  [${clock()}] ESP8266 ok: ${esp.count} readings in the last 30 s${signal}${uptime !== null ? `, up ${(uptime / 1000).toFixed(0)} s` : ''}${drops !== null ? `, Wi-Fi drops ${drops}` : ''}`);
    esp.summaryAt = now;
    esp.count = 0;
  }
  Object.assign(esp, { lastPost: now, uptime, drops, rssi, reset, silentSince: 0 });
}

setInterval(() => {
  if (esp.lastPost && !esp.silentSince && Date.now() - esp.lastPost > ESP_SILENT_MS) {
    esp.silentSince = Date.now();
    console.log(`  [${clock()}] ESP8266 silent: no reading for ${ESP_SILENT_MS / 1000} s${esp.rssi !== null ? ` (last signal ${esp.rssi} dBm)` : ''}`);
  }
}, 1000).unref();

// GET /api/distance/stream  ->  text/event-stream of { metres, at, ageMs? }
function distanceStream(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.flushHeaders();
  // The replayed reading may be old; send its age (phone and laptop clocks can differ).
  if (lastDistance) res.write(`data: ${JSON.stringify({ ...lastDistance, ageMs: Date.now() - lastDistance.at })}\n\n`);
  distanceClients.add(res);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  res.on('close', () => { clearInterval(keepAlive); distanceClients.delete(res); });
}

function handler(req, res) {
  if (req.method === 'POST' && req.url.startsWith('/distance')) return postDistance(req, res);
  if (req.method === 'GET' && req.url.startsWith('/api/distance/stream')) return distanceStream(req, res);
  if (req.method === 'POST' && req.url.startsWith('/api/describe')) return describe(req, res);
  if (req.method === 'POST' && req.url.startsWith('/api/ask')) return describe(req, res, { ask: true });
  if (req.method === 'POST' && req.url.startsWith('/api/speak')) return speak(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  send(res, 405, 'Method not allowed');
}

http.createServer(handler).listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`\nLive Scene Narrator  (model: ${MODEL})`);
  console.log(TTS_KEY
    ? `  Voice:    ElevenLabs ${TTS_MODEL}, voice ${TTS_VOICE}, pcm ${TTS_RATE} Hz, ${TTS_TAG || `speed ${TTS_SPEED}`}, early start ${EARLY_SPEECH ? 'on' : 'off'}`
    : '  Voice:    off (set ELEVENLABS_API_KEY in narrator/.env to enable)');
  console.log(`  Desktop:  http://localhost:${HTTP_PORT}`);
});

// Plain-HTTP port for the ESP8266 (it can't verify our self-signed HTTPS certificate).
// Same routes as the other ports; /distance also works on HTTP_PORT.
const DISTANCE_PORT = Number(process.env.DISTANCE_PORT || 5000);
const distanceServer = http.createServer(handler);
distanceServer.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`  ESP8266:  port ${DISTANCE_PORT} is in use${DISTANCE_PORT === 5000 && process.platform === 'darwin' ? ' (on macOS usually the AirPlay Receiver:'
    + ' System Settings > General > AirDrop & Handoff > AirPlay Receiver off)' : ''}.`);
  console.log(`            Or point the sketch at port ${HTTP_PORT}: http://${lanAddresses()[0] || '<lan-ip>'}:${HTTP_PORT}/distance`);
});
distanceServer.listen(DISTANCE_PORT, '0.0.0.0', () => {
  console.log(`  ESP8266:  set serverUrl to http://${lanAddresses()[0] || '<lan-ip>'}:${DISTANCE_PORT}/distance`);
});

const tls = ensureCert();
if (tls) {
  https.createServer(tls, handler).listen(HTTPS_PORT, '0.0.0.0', () => {
    if (localHostname()) console.log(`  Phone:    https://${localHostname()}:${HTTPS_PORT}   (same address even when the IP changes)`);
    for (const ip of lanAddresses()) console.log(`  Phone:    https://${ip}:${HTTPS_PORT}   (accept the certificate warning)`);
    console.log('');
  });
}
