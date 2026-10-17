// Checks for public/tracker.js (no camera, no API calls): node eval/tracker-test.js
const assert = require('assert');
const T = require('../public/tracker.js');

const box = (x, y, w, h) => ({ x, y, w, h });
const det = (label, b) => ({ label, score: 0.8, box: b });
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

// Feed the same detections for n frames, 66 ms apart (the 15 fps cap).
function run(frames, n = 3) {
  const tracker = T.createTracker();
  let tracks = [];
  for (let i = 0; i < n; i++) tracks = tracker.update(typeof frames === 'function' ? frames(i) : frames, i * 66);
  return tracks;
}

check('one-frame detection is not confirmed', () => {
  const tracker = T.createTracker();
  assert.strictEqual(tracker.update([det('person', box(0.4, 0.3, 0.1, 0.3))], 0).length, 0);
});

check('same object across frames keeps one id', () => {
  const tracks = run((i) => [det('person', box(0.40 + i * 0.01, 0.3, 0.1, 0.3))], 5);
  assert.strictEqual(tracks.length, 1);
  assert.strictEqual(tracks[0].id, 1);
});

check('two people ahead, two chairs on the left', () => {
  const tracks = run([
    det('person', box(0.40, 0.2, 0.08, 0.4)), det('person', box(0.52, 0.2, 0.08, 0.4)),
    det('chair', box(0.05, 0.5, 0.1, 0.2)), det('chair', box(0.18, 0.5, 0.1, 0.2)),
  ]);
  assert.strictEqual(T.summarize(tracks), '2 people ahead, 2 chairs on the left.');
});

check('close comes first and is said', () => {
  const tracks = run([det('chair', box(0.05, 0.4, 0.1, 0.2)), det('person', box(0.7, 0.3, 0.25, 0.65))]);
  assert.strictEqual(T.summarize(tracks), 'Person close on the right, chair on the left.');
});

check('single object has no number', () => {
  assert.strictEqual(T.summarize(run([det('bicycle', box(0.45, 0.4, 0.2, 0.3))])), 'Bike ahead.');
});

check('nothing tracked gives an empty line', () => {
  assert.strictEqual(T.summarize(run([])), '');
});

check('side has hysteresis at the thirds', () => {
  assert.strictEqual(T.sideOf(box(0.31, 0, 0.06, 0.1), 'left'), 'left');  // center 0.34: just past 1/3, stays left
  assert.strictEqual(T.sideOf(box(0.36, 0, 0.06, 0.1), 'left'), 'ahead'); // center 0.39: clearly past
  assert.strictEqual(T.sideOf(box(0.31, 0, 0.06, 0.1), null), 'ahead');   // no history: plain thirds
});

check('object unseen for over 500 ms is dropped', () => {
  const tracker = T.createTracker();
  const p = [det('person', box(0.4, 0.3, 0.1, 0.3))];
  tracker.update(p, 0);
  tracker.update(p, 66);
  assert.strictEqual(tracker.update([], 400).length, 1);
  assert.strictEqual(tracker.update([], 700).length, 0);
});

check('line stays within 12 words', () => {
  const many = ['person', 'bicycle', 'car', 'dog', 'bench', 'chair'].flatMap((label, i) =>
    [det(label, box(0.02 + i * 0.16, 0.2, 0.05, 0.2)), det(label, box(0.05 + i * 0.16, 0.2, 0.05, 0.2))]);
  const line = T.summarize(run(many));
  assert.ok(line.split(/\s+/).length <= T.MAX_WORDS, line);
});

check('stabilizer waits 300 ms before changing the line', () => {
  const s = T.createStabilizer(300);
  assert.strictEqual(s.next('Person ahead.', 0), '');
  assert.strictEqual(s.next('Person ahead.', 200), '');
  assert.strictEqual(s.next('Person ahead.', 300), 'Person ahead.');
  assert.strictEqual(s.next('2 people ahead.', 400), 'Person ahead.'); // flicker is ignored
  assert.strictEqual(s.next('Person ahead.', 450), 'Person ahead.');
  assert.strictEqual(s.next('2 people ahead.', 500), 'Person ahead.');
  assert.strictEqual(s.next('2 people ahead.', 800), '2 people ahead.');
});

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
