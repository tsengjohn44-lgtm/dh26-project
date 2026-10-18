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

  // The model overcounts short flights of stairs (e.g. "at least 5" for 2 gate steps, 10 for 8),
  // and an overestimate is the dangerous direction. Scale its count down; at temperature 0.2
  // this cut overestimates from 12/36 to 4/36 on test photos.
  const STAIR_COUNT_FACTOR = 0.75;
  function cautiousStairCount(text) {
    if (!/stair|step/i.test(text)) return text;
    return text.replace(/(\d+)\s*(steps?|stairs?)\b/i, (_, n, unit) => {
      const count = Math.max(1, Math.floor(Number(n) * STAIR_COUNT_FACTOR));
      const noun = unit.toLowerCase().startsWith('stair') ? 'stair' : 'step';
      return `${count} ${noun}${count === 1 ? '' : 's'}`;
    });
  }

  // { text, reason }: text is the alert to show, or null with reason 'n/a' | 'repeat'.
  function classifyReply(raw, said) {
    const text = String(raw).replace(/\s+/g, ' ').trim().replace(/^"([^"]*)"$/, '$1').trim();
    if (!text || isNothing(text)) return { text: null, reason: 'n/a' };
    if (isRepeat(text, said)) return { text: null, reason: 'repeat' };
    return { text: cautiousStairCount(text), reason: 'new' };
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

  // Focus / motion-blur measure: variance of the Laplacian over a grayscale image (row-major,
  // w x h). Sharp edges give large positive and negative Laplacian values, blur flattens them,
  // so a lower score means blurrier. Divided by the squared mean brightness: otherwise a frame
  // 40% darker (shade, exposure change) scores 0.36x and looks "blurry". Only comparable between
  // frames of similar content: a sharp photo of a blank wall also scores low (app.js compares
  // against recent frames).
  function sharpness(gray, w, h) {
    let sum = 0, sumSq = 0, n = 0, bright = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sum += lap; sumSq += lap * lap; bright += gray[i]; n++;
      }
    }
    if (!n) return 0;
    const mean = sum / n;
    const level = Math.max(bright / n, 16); // floor: near-black frames don't blow up
    return ((sumSq / n - mean * mean) / (level * level)) * 1000;
  }

  const api = { isNothing, isRepeat, classifyReply, finalizeReply, viewChange, cautiousStairCount, sharpness };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Filter = api;
})(this);
