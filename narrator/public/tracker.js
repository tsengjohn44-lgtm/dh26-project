// Fast-tier scene state from on-device detections (detector.js): follows each object across
// frames, places it left / ahead / right (and "close"), and sums the scene up in one short line,
// e.g. "2 people ahead, 2 chairs on the left." Runs in the browser (window.Tracker) and in Node
// for tests (eval/tracker-test.js).
(function (root) {
  const IOU_MATCH = 0.3;       // same label and this much box overlap = the same object as last frame
  const CONFIRM_HITS = 2;      // frames an object must be seen before it counts: drops one-frame misfires
  const MAX_MISSING_MS = 500;  // keep an object this long after it was last seen (missed frames, occlusion)
  const SMOOTH = 0.5;          // weight of the newest box in the running average; damps box jitter
  const LEFT = 1 / 3, RIGHT = 2 / 3; // frame thirds: left / ahead / right
  const HYSTERESIS = 0.04;     // must cross a third by this much to change side, so labels don't flicker
  // Within about two steps: the box reaches the bottom of the frame, or fills most of its height.
  const CLOSE_BOTTOM = 0.85, CLOSE_HEIGHT = 0.6;
  const MAX_WORDS = 12;        // same limit as Perceptron alerts
  const STABLE_MS = 300;       // a new summary must hold this long before it replaces the shown one

  const NAMES = {
    person: ['person', 'people'], bicycle: ['bike', 'bikes'], car: ['car', 'cars'],
    motorcycle: ['motorbike', 'motorbikes'], bus: ['bus', 'buses'], truck: ['truck', 'trucks'],
    dog: ['dog', 'dogs'], bench: ['bench', 'benches'], chair: ['chair', 'chairs'],
    'fire hydrant': ['hydrant', 'hydrants'], 'potted plant': ['plant', 'plants'], suitcase: ['suitcase', 'suitcases'],
  };
  // Order within the line after "close" groups: things that move first, then obstacles.
  const PRIORITY = ['person', 'bicycle', 'motorcycle', 'car', 'bus', 'truck', 'dog',
    'bench', 'chair', 'fire hydrant', 'potted plant', 'suitcase'];
  const WHERE = { left: 'on the left', ahead: 'ahead', right: 'on the right' };

  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
  }

  const blend = (old, now) => ({
    x: old.x + SMOOTH * (now.x - old.x), y: old.y + SMOOTH * (now.y - old.y),
    w: old.w + SMOOTH * (now.w - old.w), h: old.h + SMOOTH * (now.h - old.h),
  });

  // Side of the frame by box center, staying on the previous side until clearly past a third.
  function sideOf(box, prev) {
    const cx = box.x + box.w / 2;
    if (prev === 'left' && cx < LEFT + HYSTERESIS) return 'left';
    if (prev === 'right' && cx > RIGHT - HYSTERESIS) return 'right';
    if (prev === 'ahead' && cx >= LEFT - HYSTERESIS && cx <= RIGHT + HYSTERESIS) return 'ahead';
    return cx < LEFT ? 'left' : cx > RIGHT ? 'right' : 'ahead';
  }

  const isClose = (box) => box.y + box.h > CLOSE_BOTTOM || box.h > CLOSE_HEIGHT;

  // update(detections, tMs) -> confirmed tracks [{ id, label, box, side, close, hits, firstSeen, lastSeen }].
  // Matching is greedy by overlap, highest first; unmatched detections start new tracks.
  function createTracker() {
    let tracks = [];
    let nextId = 1;
    function update(dets, tMs) {
      const pairs = [];
      tracks.forEach((t, ti) => dets.forEach((d, di) => {
        if (d.label !== t.label) return;
        const overlap = iou(t.box, d.box);
        if (overlap >= IOU_MATCH) pairs.push([overlap, ti, di]);
      }));
      pairs.sort((a, b) => b[0] - a[0]);
      const usedTrack = new Set(), usedDet = new Set();
      for (const [, ti, di] of pairs) {
        if (usedTrack.has(ti) || usedDet.has(di)) continue;
        usedTrack.add(ti);
        usedDet.add(di);
        const t = tracks[ti];
        t.box = blend(t.box, dets[di].box);
        t.hits++;
        t.lastSeen = tMs;
      }
      dets.forEach((d, di) => {
        if (!usedDet.has(di)) tracks.push({ id: nextId++, label: d.label, box: { ...d.box }, hits: 1, firstSeen: tMs, lastSeen: tMs, side: null });
      });
      tracks = tracks.filter((t) => tMs - t.lastSeen <= MAX_MISSING_MS);
      for (const t of tracks) {
        t.side = sideOf(t.box, t.side);
        t.close = isClose(t.box);
      }
      return tracks.filter((t) => t.hits >= CONFIRM_HITS);
    }
    return { update, reset() { tracks = []; } };
  }

  // One line for the confirmed tracks, close groups first, at most MAX_WORDS words.
  // "" when nothing is tracked.
  function summarize(tracks) {
    const groups = new Map();
    for (const t of tracks) {
      if (!NAMES[t.label]) continue;
      const key = `${t.label}|${t.side}|${t.close}`;
      const g = groups.get(key) || { label: t.label, side: t.side, close: t.close, count: 0 };
      g.count++;
      groups.set(key, g);
    }
    const ordered = [...groups.values()].sort((a, b) =>
      (b.close - a.close) || (PRIORITY.indexOf(a.label) - PRIORITY.indexOf(b.label)) || (b.count - a.count));
    const phrases = ordered.map((g) => {
      const [one, many] = NAMES[g.label];
      const what = g.count > 1 ? `${g.count} ${many}` : one;
      const where = g.close ? (g.side === 'ahead' ? 'close ahead' : `close ${WHERE[g.side]}`) : WHERE[g.side];
      return `${what} ${where}`;
    });
    while (phrases.length > 1 && words(phrases.join(', ')) > MAX_WORDS) phrases.pop();
    if (!phrases.length) return '';
    const line = phrases.join(', ');
    return `${line[0].toUpperCase()}${line.slice(1)}.`;
  }

  const words = (text) => (text.match(/\S+/g) || []).length;

  // next(text, tMs) -> the text to show: a new value is shown only after it held for STABLE_MS,
  // so a box flickering for a frame or two doesn't change the line (or make a screen reader speak).
  function createStabilizer(stableMs = STABLE_MS) {
    let shown = '', candidate = '', since = 0;
    return {
      next(text, tMs) {
        if (text === shown) { candidate = text; return shown; }
        if (text !== candidate) { candidate = text; since = tMs; }
        if (tMs - since >= stableMs) shown = candidate;
        return shown;
      },
      reset() { shown = ''; candidate = ''; since = 0; },
    };
  }

  const api = { createTracker, summarize, createStabilizer, iou, sideOf, isClose, MAX_WORDS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Tracker = api;
})(this);
