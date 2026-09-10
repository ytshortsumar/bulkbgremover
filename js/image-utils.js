/* image-utils.js — canvas helpers: load files, composite alpha matte + background
   color, subject-aware crop, resize to presets, export PNG/JPEG. Pure browser APIs. */

const DPI = 300; // print resolution for physical (mm/in) sizes
const MM_PER_INCH = 25.4;

/* Size presets: width/height in px (physical sizes at 300 DPI). */
function mm(v) { return Math.round((v / MM_PER_INCH) * DPI); }
function inch(v) { return Math.round(v * DPI); }

export const SIZE_PRESETS = {
  'original':    { label: 'Original', w: null, h: null },
  'pk-passport': { label: 'Pakistan Passport 35×45mm', w: mm(35), h: mm(45) },
  'pk-nadra':    { label: 'NADRA / ID 35×45mm',        w: mm(35), h: mm(45) },
  'us-passport': { label: 'US Passport 2×2in',          w: inch(2), h: inch(2) },
  'us-visa':     { label: 'US Visa 600×600',            w: 600,     h: 600 },
  'schengen':    { label: 'Schengen Visa 35×45mm',      w: mm(35), h: mm(45) },
  'square':      { label: 'Square 1:1',                 w: 1000,    h: 1000 },
  'ratio-3-4':   { label: 'Portrait 3:4',               w: 900,     h: 1200 },
};

/* Largest side we ever allocate for an output canvas (guards a bad custom size). */
const MAX_SIDE = 8000;

/* Resolve the target pixel size for a chosen preset + custom inputs.
   Returns null (→ keep original size) for missing/invalid custom values. */
export function resolveTargetSize(presetKey, custom) {
  if (presetKey === 'original') return null;
  if (presetKey === 'custom') {
    const { w, h, unit } = custom || {};
    const toPx = (val) => {
      if (unit === 'mm') return mm(val);
      if (unit === 'cm') return mm(val * 10); // 1 cm = 10 mm
      if (unit === 'in') return inch(val);
      return Math.round(val); // px
    };
    let pw = toPx(w), ph = toPx(h);
    // Reject empty/zero/negative/non-numeric; clamp so a huge value can't
    // produce an unallocatable canvas.
    if (!Number.isFinite(pw) || !Number.isFinite(ph) || pw <= 0 || ph <= 0) return null;
    return { w: Math.min(pw, MAX_SIDE), h: Math.min(ph, MAX_SIDE) };
  }
  const p = SIZE_PRESETS[presetKey];
  return p && p.w ? { w: p.w, h: p.h } : null;
}

/* ---------- Loading ---------- */

/* Load a File/Blob into an HTMLImageElement (decoded & ready). */
export function loadImage(fileOrUrl) {
  return new Promise((resolve, reject) => {
    const url = typeof fileOrUrl === 'string' ? fileOrUrl : URL.createObjectURL(fileOrUrl);
    const img = new Image();
    img.onload = () => {
      if (typeof fileOrUrl !== 'string') URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      if (typeof fileOrUrl !== 'string') URL.revokeObjectURL(url);
      reject(new Error('Could not load image'));
    };
    img.src = url;
  });
}

/* Make a small thumbnail data URL for the UI (keeps DOM light for bulk). */
export function makeThumbnail(img, max = 320) {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/png');
}

/* ---------- Alpha compositing ---------- */

/* Apply a predicted alpha matte to the original image. `alpha` is length
   maskW*maskH (0..1 or 0..255); the mask is upscaled to full image res.
   Returns a full-res canvas with a transparent-background cut-out. */
export function applyAlphaMatte(img, alpha, maskW, maskH) {
  const W = img.width, H = img.height;

  // Draw original at full res.
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const imageData = ctx.getImageData(0, 0, W, H);
  const data = imageData.data;

  // Normalize alpha to a 0..255 sampler over mask grid.
  const is255 = alphaLooksLike255(alpha);
  const sampleAlpha = (mx, my) => {
    const idx = my * maskW + mx;
    const a = alpha[idx];
    return is255 ? a : a * 255;
  };

  // Nearest-neighbour upscale of the mask onto full-res pixels.
  // (RMBG masks are smooth mattes, so NN is visually fine and fast.)
  const sx = maskW / W, sy = maskH / H;
  for (let y = 0; y < H; y++) {
    const my = Math.min(maskH - 1, (y * sy) | 0);
    for (let x = 0; x < W; x++) {
      const mx = Math.min(maskW - 1, (x * sx) | 0);
      const a = sampleAlpha(mx, my);
      data[(y * W + x) * 4 + 3] = a; // set alpha channel
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function alphaLooksLike255(alpha) {
  // Sample a few values; if any > 1.5 assume 0..255 scale.
  const n = alpha.length;
  for (let i = 0; i < n; i += Math.max(1, (n / 32) | 0)) {
    if (alpha[i] > 1.5) return true;
  }
  return false;
}

/* ---------- Subject bounding box (for auto-crop) ---------- */

/* Tight bounding box of non-transparent pixels on a cut-out canvas (used to
   center the subject before cropping to a passport ratio). */
export function alphaBoundingBox(cutoutCanvas, threshold = 24) {
  const { width: W, height: H } = cutoutCanvas;
  const ctx = cutoutCanvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, W, H).data;
  let minX = W, minY = H, maxX = 0, maxY = 0, found = false;

  // Step for speed on huge images; fine enough for a bbox.
  const step = Math.max(1, Math.round(Math.max(W, H) / 1000));
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (data[(y * W + x) * 4 + 3] > threshold) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) return { x: 0, y: 0, w: W, h: H };
  // min/max are inclusive pixel indices, so the box spans (max - min + 1) px.
  return { x: minX, y: minY, w: (maxX - minX + 1), h: (maxY - minY + 1) };
}

/* ---------- Final composition (background + size) ---------- */

/* Compose the final image from a cut-out. Options: bgColor (hex | null |
   'transparent'), target ({w,h} px | null = keep original), autoCrop (center
   subject and cover-fit to the target ratio), padding (headroom fraction). */
export function composeFinal(cutoutCanvas, { bgColor, target, autoCrop = true, padding = 0.12 }) {
  const srcW = cutoutCanvas.width, srcH = cutoutCanvas.height;
  const out = document.createElement('canvas');

  // No target size → keep original dimensions.
  const W = target ? target.w : srcW;
  const H = target ? target.h : srcH;
  out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  // Paint background.
  if (bgColor && bgColor !== 'transparent') {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);
  }

  if (!target) {
    // Same size — just stack cut-out over background.
    ctx.drawImage(cutoutCanvas, 0, 0);
    return out;
  }

  // We have a target size/ratio.
  let sx = 0, sy = 0, sw = srcW, sh = srcH;

  if (autoCrop) {
    // Center on the subject bbox with padding, then cover-fit to the target
    // ratio. Reuse the engine's precomputed bbox (canvas.__bbox) when present.
    const bb = cutoutCanvas.__bbox || alphaBoundingBox(cutoutCanvas);
    const padX = bb.w * padding, padY = bb.h * padding;
    let cx0 = bb.x - padX, cy0 = bb.y - padY;
    let cw = bb.w + padX * 2, ch = bb.h + padY * 2;

    // Expand crop window to match target aspect ratio (cover).
    const targetRatio = W / H;
    const cropRatio = cw / ch;
    if (cropRatio < targetRatio) {
      const newW = ch * targetRatio;
      cx0 -= (newW - cw) / 2; cw = newW;
    } else {
      const newH = cw / targetRatio;
      cy0 -= (newH - ch) / 2; ch = newH;
    }
    // Fit the ratio-locked window inside the source without distorting it:
    // shrink uniformly if it overflows (keeps cw/ch == W/H), then clamp the
    // origin in bounds. Clamping w/h independently would break the aspect ratio.
    const fit = Math.min(1, srcW / cw, srcH / ch);
    cw *= fit; ch *= fit;
    cx0 = Math.max(0, Math.min(cx0, srcW - cw));
    cy0 = Math.max(0, Math.min(cy0, srcH - ch));
    sx = cx0; sy = cy0; sw = cw; sh = ch;
    ctx.drawImage(cutoutCanvas, sx, sy, sw, sh, 0, 0, W, H);
  } else {
    // Contain-fit the whole cut-out into the target, centered.
    const scale = Math.min(W / srcW, H / srcH);
    const dw = srcW * scale, dh = srcH * scale;
    ctx.drawImage(cutoutCanvas, 0, 0, srcW, srcH, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  return out;
}

/* Downscale a canvas so its longest side is at most `maxSide` px (returns it
   untouched when it already fits). High-quality smoothing keeps it clean. */
export function downscaleToMax(canvas, maxSide) {
  const longest = Math.max(canvas.width, canvas.height);
  if (!Number.isFinite(maxSide) || maxSide <= 0 || longest <= maxSide) return canvas;
  const scale = maxSide / longest;
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h);
  return out;
}

/* ---------- Export ---------- */

export function canvasToBlob(canvas, format = 'image/png', quality = 0.92) {
  return new Promise((resolve) => {
    // JPEG has no alpha; ensure white fallback already applied by caller
    // when they pick JPG with a transparent background.
    canvas.toBlob((b) => resolve(b), format, quality);
  });
}

/* Flatten transparency onto white — used when exporting JPG with no bg color. */
export function flattenOnWhite(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.width; out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/* Build a safe output filename. */
export function outName(originalName, format) {
  const base = (originalName || 'image').replace(/\.[^.]+$/, '');
  const ext = format === 'image/jpeg' ? 'jpg' : format === 'image/webp' ? 'webp' : 'png';
  return `${base}-bulkbgremover.${ext}`;
}
