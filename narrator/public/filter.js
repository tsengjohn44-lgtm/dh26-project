// Decides whether a model reply is worth showing, and whether the camera has moved to a new
// view. Runs in the browser (window.Filter) and in Node for tests.
(function (root) {
  // "n/a" (and "No change.") mean: nothing worth saying.
  const NOTHING = ['na', 'nochange'];
  const isNothing = (text) => NOTHING.includes(text.toLowerCase().replace(/[^a-z]/g, ''));

  // Words that don't distinguish one alert from another.
  const FILLER = new Set(['the', 'and', 'with', 'from', 'are', 'its', 'there', 'ahead', 'sign', 'reads', 'about',
    'at', 'least', 'on', 'in', 'to', 'of', 'is', 'an', 'a', 'it', 'close', 'step', 'steps']);
  // Numbers count (room 214 vs 215 are different), but stair counts don't ("at least 6 steps"
  // vs "at least 8 steps" is the same staircase). "up"/"down" are kept: they matter for stairs.
  const contentWords = (text) => new Set(
    text.toLowerCase().replace(/\d+\s*steps?/g, ' ').match(/[a-z0-9]+/g)
      ?.filter((w) => !FILLER.has(w) && (w.length > 1 || /\d/.test(w))) || [],
  );
  const isClose = (text) => /\bclose\b/i.test(text);

  // A reply restates an earlier alert when most of its content words were already in it,
  // unless it adds a new number (e.g. a room number) or the hazard has now become "close".
  function isRepeat(text, earlier) {
    const words = contentWords(text);
    if (!words.size) return false;
    return earlier.some((old) => {
      const oldWords = contentWords(old);
      if ([...words].some((w) => /\d/.test(w) && !oldWords.has(w))) return false;
      const shared = [...words].filter((w) => oldWords.has(w)).length;
      if (shared / words.size < 0.6) return false;
      return !(isClose(text) && !isClose(old));
    });
  }

  // { text, reason }: text is the alert to show, or null with reason 'n/a' | 'repeat'.
  function classifyReply(raw, said) {
    const text = String(raw).replace(/\s+/g, ' ').trim().replace(/^"([^"]*)"$/, '$1').trim();
    if (!text || isNothing(text)) return { text: null, reason: 'n/a' };
    if (isRepeat(text, said)) return { text: null, reason: 'repeat' };
    return { text, reason: 'new' };
  }
  const finalizeReply = (raw, said) => classifyReply(raw, said).text;

  // How different two small grayscale thumbnails are: 1 - correlation, so 0 = same view and
  // ~1 = unrelated. Insensitive to exposure changes. Tuned on photos: camera shake stayed
  // below 0.45 and different places were mostly above 0.5 (see VIEW_CHANGE in app.js).
  function viewChange(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
    return 1 - ab / Math.sqrt(aa * bb + 1e-9);
  }

  const api = { isNothing, isRepeat, classifyReply, finalizeReply, viewChange };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Filter = api;
})(this);
