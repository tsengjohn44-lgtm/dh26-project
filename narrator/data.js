// Saved descriptions: one JSON record per alert a phone showed, for building a dataset of what
// the app told people. Only phones with Settings > Data > Save descriptions on send anything
// (POST /api/log); records are appended to narrator/data/<YYYY-MM-DD>.jsonl (gitignored).
// Text only: no images, no location. Used by server.js; tested by eval/data-test.js.

const fs = require('fs');
const path = require('path');
const Filter = require('./public/filter.js');

const DATA_DIR = path.join(__dirname, 'data');
const ID_RE = /^[a-z0-9-]{4,64}$/i; // random ids made on the phone (app.js randomId)
// A string check first: RegExp.test(undefined) tests the text "undefined", which would pass.
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const MAX_TEXT = 300;              // alerts are at most ~12 words; anything longer is cut
const SOURCES = ['fast', 'refine']; // the normal reply, or a Fast + Low correction
const REASONING = ['none', 'hybrid', 'low', 'high'];
const STYLES = ['safety', 'classic'];

// Words in reading order, lowercase, keeping "drop-off" and "71a" whole.
const wordsOf = (text) => text.toLowerCase().match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) || [];

// What the alert says, in fields: "Drop-off: stairs going down ahead, at least 10 steps." ->
// hazard 'drop', positions ['ahead'], stairs { direction: 'down', minSteps: 10 }.
function parseAlert(text) {
  const words = wordsOf(text);
  const positions = [...new Set(words.filter((w) => w === 'left' || w === 'ahead' || w === 'right'))];
  const isStairs = /\bstair(s|case|way)?\b/i.test(text);
  const direction = /\b(going |go )?up\b/i.test(text) ? 'up' : /\b(going |go )?down\b/i.test(text) ? 'down' : null;
  const count = text.match(/\bat least (\d+)/i);
  return {
    words,
    hazard: Filter.hazardLabel(text), // 'trip' | 'drop' | 'head' | 'moving' | 'obstacle' | null
    positions,
    close: words.includes('close'),
    stairs: isStairs ? { direction, minSteps: count ? Number(count[1]) : null } : null,
    quoted: [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]), // sign text, quoted by the model
  };
}

// body from the phone -> the record to save. Throws on anything that doesn't look like one.
function buildRecord(body, now = new Date()) {
  const text = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '';
  if (!text || !isId(body.phone) || !isId(body.session)) throw new Error('Expected { phone, session, text }');
  const n = Number(body.n);
  const clientTime = typeof body.t === 'string' && !Number.isNaN(Date.parse(body.t)) ? body.t : null;
  return {
    t: now.toISOString(), // server clock: phone clocks can differ
    phone: body.phone,
    session: body.session,
    n: Number.isInteger(n) && n > 0 ? n : null, // order within the session
    text,
    ...parseAlert(text),
    source: SOURCES.includes(body.source) ? body.source : 'fast',
    reasoning: REASONING.includes(body.reasoning) ? body.reasoning : null,
    style: STYLES.includes(body.style) ? body.style : null,
    clientTime,
  };
}

// One file per local calendar day, so a day's sessions stay together.
const fileFor = (now) => path.join(DATA_DIR, `${now.toLocaleDateString('en-CA')}.jsonl`);

function appendRecord(record, now, done) {
  fs.mkdir(DATA_DIR, { recursive: true }, (err) => {
    if (err) return done(err);
    fs.appendFile(fileFor(now), `${JSON.stringify(record)}\n`, done);
  });
}

module.exports = { DATA_DIR, parseAlert, buildRecord, appendRecord, fileFor };
