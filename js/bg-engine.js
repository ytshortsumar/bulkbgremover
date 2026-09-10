/* bg-engine.js — RMBG-1.4 via Transformers.js for 100% in-browser background
   removal. Loads the model once, prefers WebGPU and falls back to WASM, and
   returns a full-resolution transparent cut-out canvas.
   License: RMBG-1.4 weights are BRIA non-commercial (this project is free/
   non-commercial); Transformers.js is Apache-2.0. To go commercial, swap
   MODEL_ID for a permissive matting model (e.g. Xenova/modnet) — only this file. */

// Pin the version the official demo is known-good against (3.7.x).
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';
const MODEL_ID = 'briaai/RMBG-1.4';

let _tf = null;          // imported module
let _model = null;
let _processor = null;
let _device = 'wasm';
let _loadingPromise = null;
let _forceWasm = false;  // sticky once we fall back to CPU (WebGPU broke on this device)

/* Processor config — REQUIRED: RMBG-1.4 ships no preprocessor config that
   Transformers.js can read, so we provide it inline. */
const PROCESSOR_CONFIG = {
  do_normalize: true,
  do_pad: false,
  do_rescale: true,
  do_resize: true,
  image_mean: [0.5, 0.5, 0.5],
  image_std: [1, 1, 1],
  feature_extractor_type: 'ImageFeatureExtractor',
  resample: 2,
  rescale_factor: 0.00392156862745098, // 1/255
  size: { width: 1024, height: 1024 },
};

/* Lazy-import Transformers.js so the page paints instantly. */
async function getTransformers() {
  if (_tf) return _tf;
  _tf = await import(/* @vite-ignore */ TRANSFORMERS_URL);
  _tf.env.allowLocalModels = false;   // pure-CDN app: skip local /models probing
  _tf.env.useBrowserCache = true;     // cache weights in the browser
  return _tf;
}

/* Detect WebGPU. We pick it only when the adapter exposes `shader-f16`, because
   the fp16 model's kernels need f16 shaders; adapters without it fall back to
   WASM (warmUp is the final guard). */
async function pickDevice() {
  try {
    if ('gpu' in navigator && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter && adapter.features?.has('shader-f16')) return 'webgpu';
    }
  } catch (_) { /* ignore */ }
  return 'wasm';
}

/* Load the model once. `onProgress(fraction 0..1, label)` reports the one-time
   model download so the UI can show a bar. */
export function loadEngine(onProgress) {
  if (_loadingPromise) return _loadingPromise;

  // If a download goes silent this long, treat the load as stalled and reject so
  // the UI can offer Retry. Progress fires per chunk, so this only trips on a
  // genuinely dead connection, not a slow one.
  const STALL_MS = 60000;

  _loadingPromise = (async () => {
    let stallTimer = null;
    let disarmed = false;
    let rejectStall;
    const stallPromise = new Promise((_, reject) => { rejectStall = reject; });
    const bump = () => {
      if (disarmed) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => rejectStall(new Error(
        'The AI model download stalled — no data received for a while. '
        + 'Check your internet connection and press Retry.')), STALL_MS);
    };
    const disarm = () => { disarmed = true; clearTimeout(stallTimer); };

    const work = (async () => {
      bump(); // arm the watchdog before the very first network fetch
      const tf = await getTransformers();
      const { AutoModel, AutoProcessor } = tf;

      _device = _forceWasm ? 'wasm' : await pickDevice();

      // Aggregate per-file progress into one fraction, weighted by bytes so the
      // big weights file dominates (a plain % average makes the bar lurch).
      const fileBytes = {};
      const progress_callback = (data) => {
        bump(); // any progress event resets the stall clock
        if (!onProgress) return;
        if (data.status === 'progress' && data.file) {
          fileBytes[data.file] = {
            loaded: Number(data.loaded) || 0,
            total: Number(data.total) || 0,
            pct: (data.progress ?? 0) / 100,
          };
          const parts = Object.values(fileBytes);
          const haveBytes = parts.every((p) => p.total > 0);
          let frac;
          if (haveBytes) {
            const loaded = parts.reduce((a, p) => a + p.loaded, 0);
            const total = parts.reduce((a, p) => a + p.total, 0);
            frac = total ? loaded / total : 0;
          } else {
            // At least one file lacked Content-Length → fall back to averaging %.
            frac = parts.reduce((a, p) => a + p.pct, 0) / parts.length;
          }
          onProgress(Math.min(0.98, frac), 'Downloading AI model…');
        }
      };

      // WebGPU must run off the proxy worker.
      const loadWith = async (device, dtype) => {
        _model = await AutoModel.from_pretrained(MODEL_ID, {
          config: { model_type: 'custom' }, // REQUIRED for RMBG-1.4
          device,
          dtype,
          progress_callback,
        });
        _processor = await AutoProcessor.from_pretrained(MODEL_ID, {
          config: PROCESSOR_CONFIG,
          progress_callback,
        });
      };

      // Load on a device. WebGPU → fp16 (fast); WASM → q8 (~44MB, smallest usable).
      // WebGPU must run ON the main thread (proxy off); WASM uses the proxy worker.
      const loadOn = async (device) => {
        _device = device;
        if (tf.env.backends?.onnx?.wasm) {
          tf.env.backends.onnx.wasm.proxy = device !== 'webgpu';
        }
        await loadWith(device, device === 'webgpu' ? 'fp16' : 'q8');
      };

      // Try the chosen device; if the download / session-create fails, fall back.
      try {
        await loadOn(_device);
      } catch (err) {
        console.warn('[bg-engine] primary load failed, falling back to WASM/q8:', err);
        await loadOn('wasm');
      }

      // Downloads done — compile/warm-up emits no progress events, so stop the
      // stall watchdog here to avoid a false "stalled" during compile.
      disarm();

      // Warm up (compile the graph) so the first image isn't slow, and so a
      // WebGPU shader-compile/driver failure surfaces HERE at load time (ORT
      // compiles WGSL lazily) rather than on every image. On WebGPU warm-up
      // failure, reload on WASM before reporting "Ready" so getDevice() is honest.
      if (onProgress) onProgress(0.99, 'Warming up…');
      try {
        await warmUp();
      } catch (e) {
        if (_device === 'webgpu') {
          console.warn('[bg-engine] WebGPU warm-up failed — reloading on WASM:', e);
          await loadOn('wasm');
          await warmUp(); // a WASM failure here is a genuine load failure → reject
        } else {
          throw e;
        }
      }

      if (onProgress) onProgress(1, 'Ready');
      return { device: _device };
    })();
    work.catch(() => {}); // handled via the race below; avoid a late unhandled rejection

    try {
      return await Promise.race([work, stallPromise]);
    } finally {
      disarm();
    }
  })().catch((err) => {
    // Don't cache a failed load — a later retry must be able to re-run.
    _loadingPromise = null;
    throw err;
  });

  return _loadingPromise;
}

export function getDevice() { return _device; }

/* Force a fresh load on the CPU (WASM) backend — the app calls this when a
   WebGPU inference fails mid-batch. The flag is sticky (rest of the batch stays
   on WASM); safe to call repeatedly and re-downloads q8 weights once if needed. */
export async function forceWasmReload(onProgress) {
  _forceWasm = true;
  _model = null;
  _processor = null;
  _loadingPromise = null;
  return loadEngine(onProgress);
}

/* Run one throwaway inference on a tiny image to trigger graph compile. */
async function warmUp() {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 16, 16);
  const { RawImage } = _tf;
  const img = await RawImage.fromURL(c.toDataURL('image/png'));
  const { pixel_values } = await _processor(img);
  await _model({ input: pixel_values });
}

/* Remove the background from an image source (File/Blob preferred). Returns a
   full-resolution transparent cut-out canvas; the caller adds a background
   color / crop via image-utils.composeFinal(). */
export async function removeBackground(source) {
  if (!_model || !_processor) {
    throw new Error('Engine not loaded. Call loadEngine() first.');
  }
  const { RawImage } = _tf;

  // Load at ORIGINAL resolution. Prefer Blob/File (robust — no revoked URLs).
  let image;
  if (source instanceof Blob) {
    image = await RawImage.fromBlob(source);
  } else if (typeof source === 'string') {
    image = await RawImage.fromURL(source);
  } else if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    image = await RawImage.fromURL(source.src);
  } else {
    throw new Error('Unsupported image source');
  }

  // Preprocess (resizes to 1024×1024 internally) → run model.
  const { pixel_values } = await _processor(image);
  const { output } = await _model({ input: pixel_values });

  // Cap the working resolution: huge phone photos would blow past canvas limits
  // and allocate hundreds of MB. The matte is only 1024² and crops are smaller,
  // so downscaling the output to MAX_WORK_SIDE px loses nothing useful.
  const MAX_WORK_SIDE = 4096;
  const scale = Math.min(1, MAX_WORK_SIDE / Math.max(image.width, image.height));
  const W = Math.max(1, Math.round(image.width * scale));
  const H = Math.max(1, Math.round(image.height * scale));

  // Matte: output[0] is single-channel 0..1. Scale to 0..255, cast, and
  // smoothly resize to the working size (nice edges on hair).
  const mask = await RawImage
    .fromTensor(output[0].mul(255).to('uint8'))
    .resize(W, H);
  const maskData = mask.data; // Uint8Array length = W*H (1 channel)

  // Composite original RGB + predicted alpha onto a canvas at the working size.
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image.toCanvas(), 0, 0, W, H);
  const pixels = ctx.getImageData(0, 0, W, H);
  // Write the matte into the alpha channel and, in the same pass, track the
  // subject's bounding box. composeFinal() reuses this (canvas.__bbox) for
  // auto-crop instead of a second getImageData scan.
  const AT = 24; // alpha threshold — matches alphaBoundingBox()
  let minX = W, minY = H, maxX = -1, maxY = -1;
  let i = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const a = maskData[i];
      pixels.data[4 * i + 3] = a; // write matte into alpha channel
      if (a > AT) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  ctx.putImageData(pixels, 0, 0);
  canvas.__bbox = (maxX >= 0)
    ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
    : { x: 0, y: 0, w: W, h: H };
  return canvas;
}
