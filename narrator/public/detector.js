// On-device object detector for the fast tier: people, vehicles, dogs and common COCO obstacles,
// at camera rate, so Perceptron can stay on what COCO can't see (stairs, curbs, doors, text).
// The runtime and model load from pinned URLs only when createDetector() is called, so the app
// downloads nothing unless the detector is switched on. Boxes are normalised to 0-1 of the frame.
(function (root) {
  // @mediapipe/tasks-vision (Apache-2.0), released 2026-07-31. Pinned: the wasm and JS must match.
  const MP_VERSION = '1.0.1';
  const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
  // EfficientDet-Lite on COCO, hosted by Google (Apache-2.0). Lite0 takes 320 px input, Lite2
  // 448 px. The GPU delegate needs the float16 files: with int8 files it returned no detections
  // at all on the test images, while the CPU delegate found the same objects.
  const MODEL_URL = (name, type) => `https://storage.googleapis.com/mediapipe-models/object_detector/${name}/${type}/1/${name}.tflite`;
  const MODELS = {
    lite0: MODEL_URL('efficientdet_lite0', 'int8'),         // 4.6 MB, CPU only
    'lite0-f16': MODEL_URL('efficientdet_lite0', 'float16'), // 6.9 MB
    lite2: MODEL_URL('efficientdet_lite2', 'int8'),         // 7.5 MB, CPU only
    'lite2-f16': MODEL_URL('efficientdet_lite2', 'float16'), // 11.6 MB
  };
  // COCO classes the fast tier reports; everything else is left to Perceptron.
  const CLASSES = ['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'dog',
    'bench', 'chair', 'fire hydrant', 'potted plant', 'suitcase'];
  const SCORE_MIN = 0.35; // below this, Lite0 boxes are mostly noise; revisit with real frames
  const MAX_RESULTS = 20;

  let vision = null; // { mp, fileset }, shared by every detector created on the page
  function loadVision() {
    vision ??= import(`${MP_BASE}/vision_bundle.mjs`).then(async (mp) => ({
      mp,
      fileset: await mp.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`),
    }));
    return vision;
  }

  // model: a key of MODELS; delegate: 'GPU' (WebGL2) | 'CPU' (wasm). Throws if the delegate
  // can't start, so the caller can fall back to CPU.
  async function createDetector({ model = 'lite0-f16', delegate = 'GPU', scoreMin = SCORE_MIN } = {}) {
    const { mp, fileset } = await loadVision();
    const det = await mp.ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS[model], delegate },
      runningMode: 'VIDEO',
      scoreThreshold: scoreMin,
      maxResults: MAX_RESULTS,
      categoryAllowlist: CLASSES,
    });
    let lastTs = 0;
    return {
      model,
      delegate,
      // source: <video>, <canvas> or <img>. Returns [{ label, score, box: { x, y, w, h } }].
      detect(source, tMs) {
        const w = source.videoWidth || source.naturalWidth || source.width;
        const h = source.videoHeight || source.naturalHeight || source.height;
        if (!w || !h) return [];
        const ts = Math.max(Math.round(tMs), lastTs + 1); // VIDEO mode needs increasing timestamps
        lastTs = ts;
        return det.detectForVideo(source, ts).detections.map((d) => {
          const b = d.boundingBox;
          const c = d.categories[0];
          return { label: c.categoryName, score: c.score, box: { x: b.originX / w, y: b.originY / h, w: b.width / w, h: b.height / h } };
        });
      },
      close() { det.close(); },
    };
  }

  root.Detector = { createDetector, CLASSES, MODELS, MP_VERSION };
})(this);
