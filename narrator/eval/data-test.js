// Checks for data.js (no server, no API calls): node narrator/eval/data-test.js
const assert = require('assert');
const D = require('../data');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
const ok = { phone: 'a1b2c3d4-0000', session: 'e5f6a7b8-1111' };

check('stairs going down: hazard, position, direction and count', () => {
  const p = D.parseAlert('Drop-off: stairs going down ahead, at least 10 steps.');
  assert.deepStrictEqual(p.words, ['drop-off', 'stairs', 'going', 'down', 'ahead', 'at', 'least', '10', 'steps']);
  assert.strictEqual(p.hazard, 'drop');
  assert.deepStrictEqual(p.positions, ['ahead']);
  assert.deepStrictEqual(p.stairs, { direction: 'down', minSteps: 10 });
  assert.strictEqual(p.close, false);
});

check('stairs going up, close', () => {
  const p = D.parseAlert('Trip hazard: stairs going up close ahead, at least 5 steps.');
  assert.strictEqual(p.hazard, 'trip');
  assert.deepStrictEqual(p.stairs, { direction: 'up', minSteps: 5 });
  assert.strictEqual(p.close, true);
});

check('moving hazard from the left', () => {
  const p = D.parseAlert('Moving hazard: bike approaching from the left.');
  assert.strictEqual(p.hazard, 'moving');
  assert.deepStrictEqual(p.positions, ['left']);
  assert.strictEqual(p.stairs, null);
});

check('sign text is kept as quoted', () => {
  const p = D.parseAlert('Door on right, sign reads "Room 214".');
  assert.strictEqual(p.hazard, null);
  assert.deepStrictEqual(p.quoted, ['Room 214']);
  assert.deepStrictEqual(p.positions, ['right']);
});

check('classic style (no label) still parses', () => {
  const p = D.parseAlert('Stairs going up ahead, at least 3 steps.');
  assert.strictEqual(p.hazard, null);
  assert.deepStrictEqual(p.stairs, { direction: 'up', minSteps: 3 });
});

check('record has server time, ids, order, words and defaults', () => {
  const now = new Date('2026-10-18T09:00:00Z');
  const r = D.buildRecord({ ...ok, n: 3, text: '  Obstacle:   pole,\n ahead. ', source: 'nope', reasoning: 'low', style: 'safety', t: '2026-10-18T08:59:59.500Z' }, now);
  assert.strictEqual(r.t, '2026-10-18T09:00:00.000Z');
  assert.strictEqual(r.text, 'Obstacle: pole, ahead.');
  assert.strictEqual(r.n, 3);
  assert.strictEqual(r.hazard, 'obstacle');
  assert.strictEqual(r.source, 'fast');      // unknown source falls back
  assert.strictEqual(r.reasoning, 'low');
  assert.strictEqual(r.clientTime, '2026-10-18T08:59:59.500Z');
});

check('bad records are refused', () => {
  assert.throws(() => D.buildRecord({ ...ok, text: '' }));
  assert.throws(() => D.buildRecord({ ...ok, phone: '../../etc', text: 'Door ahead.' }));
  assert.throws(() => D.buildRecord({ session: ok.session, text: 'Door ahead.' }));
  assert.throws(() => D.buildRecord(null));
});

check('long text is cut to 300 characters', () => {
  assert.strictEqual(D.buildRecord({ ...ok, text: 'x'.repeat(1000) }).text.length, 300);
});

check('one file per local day', () => {
  assert.match(D.fileFor(new Date(2026, 9, 18, 23, 30)), /data[\\/]2026-10-18\.jsonl$/);
});

check('records without a type are alerts (older phones)', () => {
  assert.strictEqual(D.buildRecord({ ...ok, text: 'Door ahead.' }).type, 'alert');
});

check('start record keeps settings and camera, no text needed', () => {
  const r = D.buildRecord({ ...ok, type: 'start', n: 1, reasoning: 'hybrid', style: 'classic', intervalMs: 400, voice: true, camera: 'Back Ultra Wide · 1920×1440' });
  assert.strictEqual(r.type, 'start');
  assert.strictEqual(r.reasoning, 'hybrid');
  assert.strictEqual(r.intervalMs, 400);
  assert.strictEqual(r.voice, true);
  assert.strictEqual(r.camera, 'Back Ultra Wide · 1920×1440');
  assert.strictEqual(r.text, undefined);
});

check('quiet and stop records carry seconds, rounded to 0.1 s', () => {
  assert.strictEqual(D.buildRecord({ ...ok, type: 'quiet', seconds: 42.345 }).seconds, 42.3);
  const stop = D.buildRecord({ ...ok, type: 'stop', seconds: 600, alerts: 37 });
  assert.strictEqual(stop.seconds, 600);
  assert.strictEqual(stop.alerts, 37);
});

check('bad typed records are refused', () => {
  assert.throws(() => D.buildRecord({ ...ok, type: 'quiet' }));                // no seconds
  assert.throws(() => D.buildRecord({ ...ok, type: 'quiet', seconds: -1 }));
  assert.throws(() => D.buildRecord({ ...ok, type: 'stop', seconds: 'soon' }));
  assert.throws(() => D.buildRecord({ ...ok, type: 'video', text: 'x' }));     // unknown type
  assert.throws(() => D.buildRecord({ ...ok, type: 'alert' }));                // alert needs text
});

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
