/* app.js — BulkBGRemover UI controller. Wires the dropzone, options, bulk
   processing, results grid, download gate, and ZIP export. */

import * as engine from './bg-engine.js';
import {
  loadImage, makeThumbnail, composeFinal,
  canvasToBlob, flattenOnWhite, outName, resolveTargetSize, downscaleToMax,
  SIZE_PRESETS,
} from './image-utils.js';
import { verifyKey } from './keys.js';
import { isConfigured } from './firebase-config.js';

/* Where the unlocked serial key is remembered so it needn't be re-entered.
   Cleared automatically if it ever stops working (disabled/expired/reset). */
const KEY_STORAGE = 'bulkbg.key';

/* Persist the user's last-used options (bg color, size, format, quality) so a
   returning visitor keeps their setup. Whitelisted on read — see loadSettings(). */
const SETTINGS_STORAGE = 'bulkbg.settings';

/* An already-unlocked session re-checks its key against the server at most this
   often, so a key disabled/expired mid-session eventually re-locks. */
const REVERIFY_MS = 10 * 60 * 1000; // 10 minutes

/* Soft, non-blocking warning once a batch grows past this many photos. */
const SOFT_BATCH_LIMIT = 30;

/* JSZip is loaded on demand (only when the user downloads all). */
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

/* Support contact shown in the serial-key dialog. >>> EDIT THESE <<< */
const SUPPORT_CONTACT = {
  email: 'ytshortsumar@gmail.com',
  whatsapp: 'https://wa.me/923326497663', // 0332 6497663 (Pakistan, +92)
  whatsappLabel: '0332 6497663',
};

/* ---------- Color presets ---------- */
const COLORS = [
  { name: 'Transparent', value: 'transparent' },
  { name: 'Passport Blue', value: '#2563eb' },
  { name: 'Sky Blue', value: '#3b9ae1' },
  { name: 'White', value: '#ffffff' },
  { name: 'Off White', value: '#f3f4f6' },
  { name: 'Red', value: '#e11d48' },
  { name: 'Gray', value: '#9ca3af' },
  { name: 'Light Gray', value: '#d1d5db' },
  { name: 'Green', value: '#16a34a' },
  { name: 'Black', value: '#111827' },
];

/* ---------- State ---------- */
const state = {
  items: [],          // { id, file, name, img, thumb, status, resultBlob, resultUrl }
  bgColor: '#2563eb', // default: passport blue
  sizePreset: 'original',
  custom: { w: 600, h: 600, unit: 'px' },
  autoCrop: true,
  format: 'image/png',
  quality: 'hd',      // 'hd' = full resolution · 'normal' = longest side ≤ 1000px
  engineReady: false,
  processing: false,
  unlocked: false,    // true once a valid serial key is entered (per session)
  keyExpiry: null,    // ms timestamp the active key expires (null = lifetime)
  lastVerify: 0,      // ms of the last successful server verify (periodic re-check)
  warnedLargeBatch: false, // shown the large-batch guardrail once this batch
  runId: 0,           // bumped by clearAll to abort any in-flight run / re-render
};

let nextId = 1;

/* ---------- DOM refs ---------- */
const $ = (sel) => document.querySelector(sel);
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
const swatchesEl = $('#swatches');
const customColor = $('#customColor');
const customColorHex = $('#customColorHex');
const customColorPreview = $('#customColorPreview');
const sizePreset = $('#sizePreset');
const customSize = $('#customSize');
const customW = $('#customW');
const customH = $('#customH');
const customUnit = $('#customUnit');
const autoCropEl = $('#autoCrop');
const outputQuality = $('#outputQuality');
const processPanel = $('#processPanel');
const processBtn = $('#processBtn');
const downloadAllBtn = $('#downloadAllBtn');
const clearBtn = $('#clearBtn');
const engineStatus = $('#engineStatus');
const engineStatusTitle = $('#engineStatusTitle');
const engineStatusDetail = $('#engineStatusDetail');
const engineProgress = $('#engineProgress');
const batchStatus = $('#batchStatus');
const batchStatusText = $('#batchStatusText');
const batchProgress = $('#batchProgress');
const resultsEl = $('#results');
const attribution = $('#attribution');
const pickTransparent = $('#pickTransparent');

/* ---------- Init ---------- */
function init() {
  loadSettings();       // restore last-used options before the UI is built
  buildSwatches();
  bindDropzone();
  bindOptions();
  bindActions();
  bindKeyModal();
  bindLightbox();
  fillSupport();
  applySettingsToUI();  // reflect restored options into the controls
  restoreUnlock();
  registerServiceWorker();
  attribution.innerHTML =
    'AI by RMBG-1.4 (BRIA) · runs locally via Transformers.js · for non-commercial use.';
}

/* Register the service worker for offline app-shell caching (PWA). Best-effort —
   a failure here never blocks the app. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return; // skip file://
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[sw] registration failed', e));
  });
}

/* On load, silently re-check a saved key so returning users stay unlocked (and
   the device binding is refreshed). If it's genuinely invalid now, forget it so
   the modal reappears; a transient/offline failure keeps the key. */
async function restoreUnlock() {
  if (!isConfigured()) return;
  let saved = '';
  try { saved = localStorage.getItem(KEY_STORAGE) || ''; } catch (_) { return; }
  if (!saved) return;
  try {
    const res = await verifyKey(saved);
    if (res.ok) {
      state.unlocked = true;
      state.keyExpiry = res.expiresAt || null;
      state.lastVerify = Date.now();
    } else if (!res.transient) {
      // Genuinely invalid now → forget it so the modal reappears.
      try { localStorage.removeItem(KEY_STORAGE); } catch (_) {}
    }
  } catch (_) { /* network hiccup — keep the saved key, try again next load */ }
}

/* ---------- Remembered settings (bg color · size · format · quality) ---------- */
const VALID_PRESETS = new Set([...Object.keys(SIZE_PRESETS), 'custom']);
const VALID_FORMATS = new Set(['image/png', 'image/jpeg']);
const VALID_UNITS = new Set(['px', 'mm', 'cm', 'in']);

/* Read + whitelist-validate saved options, merging only valid values into state
   (corrupt/unknown values are ignored — a tampered blob can't restore a bad one). */
function loadSettings() {
  let raw;
  try { raw = localStorage.getItem(SETTINGS_STORAGE); } catch (_) { return; }
  if (!raw) return;
  let s;
  try { s = JSON.parse(raw); } catch (_) { return; }
  if (!s || typeof s !== 'object') return;

  if (s.bgColor === 'transparent' || /^#[0-9a-fA-F]{6}$/.test(s.bgColor || '')) {
    state.bgColor = s.bgColor;
  }
  if (VALID_PRESETS.has(s.sizePreset)) state.sizePreset = s.sizePreset;
  if (s.custom && typeof s.custom === 'object') {
    const w = +s.custom.w, h = +s.custom.h;
    if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 && VALID_UNITS.has(s.custom.unit)) {
      state.custom = { w, h, unit: s.custom.unit };
    }
  }
  if (typeof s.autoCrop === 'boolean') state.autoCrop = s.autoCrop;
  if (VALID_FORMATS.has(s.format)) state.format = s.format;
  if (s.quality === 'hd' || s.quality === 'normal') state.quality = s.quality;
}

/* Reflect the (possibly restored) state into the actual form controls. Called
   after the swatches/options are built so every element exists. */
function applySettingsToUI() {
  if (sizePreset) sizePreset.value = state.sizePreset;
  if (customSize) customSize.hidden = state.sizePreset !== 'custom';
  if (customW) customW.value = state.custom.w;
  if (customH) customH.value = state.custom.h;
  if (customUnit) customUnit.value = state.custom.unit;

  if (autoCropEl) autoCropEl.checked = state.autoCrop;
  if (outputQuality) outputQuality.value = state.quality === 'normal' ? 'normal' : 'hd';

  document.querySelectorAll('input[name="format"]').forEach((r) => { r.checked = (r.value === state.format); });

  // Keep the custom color picker/hex in sync (swatch highlight is already
  // driven by state.bgColor inside buildSwatches).
  if (state.bgColor && state.bgColor !== 'transparent') {
    if (customColor) customColor.value = state.bgColor;
    if (customColorHex) customColorHex.value = state.bgColor.toUpperCase();
    if (customColorPreview) customColorPreview.style.background = state.bgColor;
    // A saved custom (non-preset) color matches no swatch — clear the highlight.
    if (!COLORS.some((c) => c.value === state.bgColor)) {
      [...swatchesEl.children].forEach((c) => c.classList.remove('selected'));
    }
  }
}

/* Persist the whitelisted subset of options. Called from each change handler. */
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE, JSON.stringify({
      bgColor: state.bgColor,
      sizePreset: state.sizePreset,
      custom: state.custom,
      autoCrop: state.autoCrop,
      format: state.format,
      quality: state.quality,
    }));
  } catch (_) { /* storage full / blocked — options just won't persist */ }
}

/* ---------- Swatches ---------- */
function buildSwatches() {
  swatchesEl.innerHTML = '';
  COLORS.forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch' + (c.value === 'transparent' ? ' transparent' : '');
    if (c.value !== 'transparent') btn.style.background = c.value;
    btn.title = c.name;
    btn.setAttribute('aria-label', c.name);
    btn.dataset.value = c.value;
    btn.innerHTML = `<span class="swatch-check">${checkSvg()}</span>`;
    const isSel = c.value === state.bgColor;
    if (isSel) btn.classList.add('selected');
    btn.setAttribute('aria-pressed', isSel ? 'true' : 'false');
    btn.addEventListener('click', () => selectColor(c.value, btn));
    swatchesEl.appendChild(btn);
  });
}
function checkSvg() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
}
function selectColor(value, btn) {
  state.bgColor = value;
  [...swatchesEl.children].forEach((c) => { c.classList.remove('selected'); c.setAttribute('aria-pressed', 'false'); });
  if (btn) { btn.classList.add('selected'); btn.setAttribute('aria-pressed', 'true'); }
  if (value !== 'transparent') {
    customColor.value = value;
    customColorHex.value = value.toUpperCase();
    customColorPreview.style.background = value;
  }
  saveSettings();
  // Re-render previews live if already processed.
  reRenderIfDone();
}

/* ---------- Dropzone ---------- */
function bindDropzone() {
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', (e) => { addFiles(e.target.files); fileInput.value = ''; });

  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (files?.length) addFiles(files);
  });

  // Allow paste from clipboard.
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.type.startsWith('image/'))
      .map((i) => i.getAsFile())
      .filter(Boolean);
    if (files.length) addFiles(files);
  });
}

/* Accept anything the browser reports as an image, plus common photo extensions
   even when the OS reports no MIME type (e.g. iPhone .HEIC often arrives typeless
   on Android/desktop). Typeless HEIC still won't *decode*, but letting it in lets
   us show a helpful "convert to JPG" message instead of silently dropping it. */
function isImageFile(f) {
  return f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(f.name || '');
}

/* A friendlier decode-failure message. iPhone HEIC/HEIF can't be decoded by
   Chrome/Firefox, which is the #1 "why won't my photo load" for our users. */
function describeLoadError(file) {
  const name = (file && file.name || '').toLowerCase();
  const type = (file && file.type || '').toLowerCase();
  if (/\.(heic|heif)$/.test(name) || type.includes('heic') || type.includes('heif')) {
    return 'iPhone HEIC photo — please save/convert it to JPG or PNG first (on iPhone: Settings → Camera → Formats → Most Compatible).';
  }
  return 'Unreadable image';
}

async function addFiles(fileList) {
  const files = [...fileList].filter(isImageFile);
  if (!files.length) { toast('Please choose image files.', 'error'); return; }

  for (const file of files) {
    const id = nextId++;
    const item = { id, file, name: file.name, img: null, thumb: null,
      status: 'queued', resultBlob: null, resultUrl: null, cutout: null };
    state.items.push(item);
    renderCard(item);
    // Decode + thumbnail in the background.
    loadImage(file)
      .then((img) => { item.img = img; item.thumb = makeThumbnail(img); updateCard(item); })
      .catch(() => { item.status = 'error'; item.error = describeLoadError(file); updateCard(item); });
  }
  processPanel.hidden = false;
  updateProcessButton();
  toast(`${files.length} photo${files.length > 1 ? 's' : ''} added.`, 'success');

  // Warm the AI in the background so the model download overlaps with the user
  // picking options — the first "Remove backgrounds" then feels much faster.
  ensureEngine(true);

  // Gentle, non-blocking guardrail once the batch gets large — warned once.
  if (!state.warnedLargeBatch && state.items.length > SOFT_BATCH_LIMIT) {
    state.warnedLargeBatch = true;
    toast(`Large batch (${state.items.length} photos) — your browser may slow down or run low on memory. Consider processing in smaller groups.`, 'error');
  }
}

/* ---------- Options ---------- */
function bindOptions() {
  customColor.addEventListener('input', () => {
    const v = customColor.value;
    customColorHex.value = v.toUpperCase();
    customColorPreview.style.background = v;
    selectColor(v, null);
    // Clear preset selection highlight (custom color isn't a preset).
    [...swatchesEl.children].forEach((c) => c.classList.remove('selected'));
  });
  customColorHex.addEventListener('change', () => {
    let v = customColorHex.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      customColor.value = v; customColorPreview.style.background = v; selectColor(v, null);
      [...swatchesEl.children].forEach((c) => c.classList.remove('selected'));
    } else { toast('Enter a hex color like #2563EB', 'error'); }
  });

  sizePreset.addEventListener('change', () => {
    state.sizePreset = sizePreset.value;
    customSize.hidden = sizePreset.value !== 'custom';
    saveSettings();
    reRenderIfDone();
  });
  [customW, customH, customUnit].forEach((el) =>
    el.addEventListener('change', () => {
      const w = +customW.value, h = +customH.value;
      if (customW.value !== '' && customH.value !== '' &&
          (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)) {
        toast('Width and height must be positive numbers.', 'error');
      }
      state.custom = { w, h, unit: customUnit.value };
      saveSettings();
      reRenderIfDone();
    }));
  autoCropEl.addEventListener('change', () => { state.autoCrop = autoCropEl.checked; saveSettings(); reRenderIfDone(); });

  if (outputQuality) outputQuality.addEventListener('change', () => {
    state.quality = outputQuality.value === 'normal' ? 'normal' : 'hd';
    saveSettings();
    reRenderIfDone();
  });

  document.querySelectorAll('input[name="format"]').forEach((r) =>
    r.addEventListener('change', () => { if (r.checked) { state.format = r.value; saveSettings(); reRenderIfDone(); } }));

  pickTransparent.addEventListener('click', () => {
    const t = [...swatchesEl.children].find((c) => c.dataset.value === 'transparent');
    selectColor('transparent', t);
  });
}

/* ---------- Actions ---------- */
function bindActions() {
  processBtn.addEventListener('click', processAll);
  downloadAllBtn.addEventListener('click', downloadAllZip);
  clearBtn.addEventListener('click', clearAll);

  const engineRetry = $('#engineRetry');
  if (engineRetry) engineRetry.addEventListener('click', () => {
    hideEngineRetry();
    // If there's queued/failed work, retrying the whole run also reloads the
    // engine; otherwise just reload the engine on its own.
    if (state.items.some((i) => i.status === 'queued' || i.status === 'error')) processAll();
    else ensureEngine(false);
  });

  resultsEl.addEventListener('click', (e) => {
    // Gate individual "Save" links: a single image is free; with 2+ images a
    // valid key is required. We must decide synchronously so the native <a>
    // download is blocked before the async key check can run.
    const dl = e.target.closest('.card-dl');
    if (dl) {
      if (doneCount() <= 1 || state.unlocked || !isConfigured()) return; // free → allow native download
      e.preventDefault();
      const item = itemFromEl(dl);
      if (!item || !item.resultUrl) return;
      ensureUnlocked().then((ok) => {
        if (ok) triggerDownload(item.resultUrl, outName(item.name, state.format));
      });
      return;
    }
    // Tap a finished thumbnail → open a zoomable full-size preview.
    const thumb = e.target.closest('.card-thumb');
    if (thumb) {
      const item = itemFromEl(thumb);
      if (item && item.status === 'done' && item.resultUrl) openLightbox(item.resultUrl, item.name);
    }
  });
}

function updateProcessButton() {
  processBtn.disabled = state.processing || !state.items.length;
  clearBtn.hidden = !state.items.length;
}

/* Shared engine-load progress → the engine status UI, so the bar is already
   populated whether the background prefetch or the Process click started it. */
function engineProgressCb(frac, label) {
  engineProgress.style.width = Math.round(frac * 100) + '%';
  engineStatusTitle.textContent = label || 'Preparing the AI…';
  if (frac >= 1) engineStatusDetail.textContent = 'Model ready — cached for next time.';
}

let engineHideTimer = null;

/* Load the AI model once, showing progress and a Retry button on failure.
   `background` = opportunistic prefetch: stays silent on failure. Returns true
   when ready; loadEngine() memoizes, so overlapping calls are safe. */
async function ensureEngine(background = false) {
  if (state.engineReady) return true;
  clearTimeout(engineHideTimer);
  if (!background) {
    engineStatus.hidden = false;
    engineStatus.classList.remove('ready');
    hideEngineRetry();
  }
  try {
    await engine.loadEngine(engineProgressCb);
    state.engineReady = true;
    if (!background) markEngineReady();
    return true;
  } catch (err) {
    console.error(err);
    if (background) return false; // silent — a later Process click will surface it
    engineStatus.hidden = false;
    engineStatus.classList.remove('ready');
    engineStatusTitle.textContent = 'Could not load the AI model';
    engineStatusDetail.textContent = (err && err.message)
      ? err.message
      : 'Check your internet connection and try again.';
    showEngineRetry();
    toast('Failed to load AI model. Check connection.', 'error');
    return false;
  }
}

/* Flash "Ready (device)" then auto-hide the engine block shortly after. */
function markEngineReady() {
  engineStatus.hidden = false;
  engineStatus.classList.add('ready');
  engineStatusTitle.textContent = `Ready (${engine.getDevice().toUpperCase()})`;
  engineStatusDetail.textContent = 'Model cached — future runs start instantly.';
  engineProgress.style.width = '100%';
  hideEngineRetry();
  clearTimeout(engineHideTimer);
  engineHideTimer = setTimeout(() => { if (state.engineReady) engineStatus.hidden = true; }, 2500);
}

function showEngineRetry() { const b = $('#engineRetry'); if (b) b.hidden = false; }
function hideEngineRetry() { const b = $('#engineRetry'); if (b) b.hidden = true; }

/* ---------- Processing pipeline ---------- */
async function processAll() {
  if (state.processing) return;
  state.processing = true;
  const myRun = state.runId;      // if Clear is pressed, state.runId changes → we bail out
  updateProcessButton();
  processBtn.querySelector('.btn-label').textContent = 'Working…';

  // 1) Ensure the engine is loaded (one-time model download; a background
  //    prefetch may already have it ready). ensureEngine() owns the progress UI.
  if (!state.engineReady) {
    const ok = await ensureEngine(false);
    if (!ok) {
      state.processing = false;
      updateProcessButton();
      processBtn.querySelector('.btn-label').textContent = 'Remove backgrounds';
      return;
    }
  }
  if (myRun !== state.runId) return; // cleared while the model was loading

  // 2) Process each queued image sequentially (keeps memory bounded).
  const queue = state.items.filter((i) => i.status === 'queued' || i.status === 'error');
  const total = queue.length;
  const showBatch = total > 1;    // a progress bar only earns its place for real batches
  const batchStart = Date.now();
  // The engine "Ready" flash has done its job now that work is starting; the
  // batch bar (or the button label for a single image) takes over from here.
  if (state.engineReady) engineStatus.hidden = true;
  if (showBatch && batchStatus) {
    batchStatus.hidden = false;
    batchProgress.style.width = '0%';
    batchStatusText.textContent = `Processing 1 of ${total}…`;
  }
  let done = 0;
  for (const item of queue) {
    if (myRun !== state.runId) return; // Clear pressed — abandon the run
    if (!item.img) { // wait for decode if needed
      try { item.img = await loadImage(item.file); item.thumb = makeThumbnail(item.img); }
      catch { item.status = 'error'; item.error = 'Unreadable'; updateCard(item); continue; }
    }
    item.status = 'processing';
    updateCard(item);
    try {
      // Engine returns a transparent cut-out canvas.
      // Pass the original File (robust — avoids revoked object URLs).
      item.cutout = await removeBgWithFallback(item);
      if (myRun !== state.runId) return; // cancelled during inference
      await renderResult(item);    // compose (awaited → export errors are caught here)
      item.status = 'done';
      item.img = null;             // free the full-res decode; re-render uses item.cutout
    } catch (err) {
      console.error('[process]', item.name, err);
      item.status = 'error';
      item.error = 'Failed';
    }
    updateCard(item);
    done++;
    processBtn.querySelector('.btn-label').textContent = `Working… ${done}/${total}`;
    if (showBatch && batchStatus) updateBatchStatus(done, total, batchStart);
    // Yield to keep UI responsive.
    await new Promise((r) => setTimeout(r, 0));
  }

  if (myRun !== state.runId) return;
  if (batchStatus) batchStatus.hidden = true;
  engineStatus.hidden = true;
  state.processing = false;
  processBtn.querySelector('.btn-label').textContent = 'Remove backgrounds';
  updateProcessButton();
  const okCount = state.items.filter((i) => i.status === 'done').length;
  if (okCount) { downloadAllBtn.hidden = false; toast(`Done! ${okCount} image${okCount > 1 ? 's' : ''} ready.`, 'success'); }
}

/* Update the batch progress bar + ETA line. `done` = images finished so far. */
function updateBatchStatus(done, total, startMs) {
  const frac = total ? done / total : 1;
  batchProgress.style.width = Math.round(frac * 100) + '%';
  const remaining = total - done;
  if (remaining <= 0) { batchStatusText.textContent = 'Finishing…'; return; }
  const perItem = (Date.now() - startMs) / Math.max(1, done); // avg from work done so far
  batchStatusText.textContent = `Processing ${done + 1} of ${total} · ${fmtEta(perItem * remaining)}`;
}

/* Human ETA: "~8s left" under a minute, else "~3m left". */
function fmtEta(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `~${s}s left`;
  return `~${Math.round(s / 60)}m left`;
}

/* Remove one image's background; if a WebGPU inference fails mid-run, drop to the
   CPU (WASM) backend for the rest of the batch and retry this photo. Guarded by
   getDevice() so a second failure can't loop between backends. */
async function removeBgWithFallback(item) {
  try {
    return await engine.removeBackground(item.file);
  } catch (err) {
    if (engine.getDevice() === 'webgpu') {
      console.warn('[process] WebGPU inference failed — switching to CPU:', err);
      toast('Switched to reliable CPU mode for this batch.', '');
      engineStatus.hidden = false;
      engineStatus.classList.remove('ready');
      engineStatusTitle.textContent = 'Switching to CPU mode…';
      engineStatusDetail.textContent = 'One-time reload on the reliable CPU backend.';
      await engine.forceWasmReload(engineProgressCb);
      markEngineReady();
      return await engine.removeBackground(item.file);
    }
    throw err;
  }
}

/* Re-compose the final image from an existing cut-out using current options. */
async function renderResult(item) {
  if (!item.cutout) return;
  // Generation guard: if options change again before this async render
  // finishes, a newer render supersedes it and this one is discarded.
  const gen = (item.renderGen = (item.renderGen || 0) + 1);
  const target = resolveTargetSize(state.sizePreset, state.custom);
  let canvas = composeFinal(item.cutout, {
    bgColor: state.bgColor,
    target,
    autoCrop: state.autoCrop,
  });
  // Normal output: shrink the longest side to 1000px for a smaller file.
  // HD leaves the full/print resolution untouched.
  if (state.quality === 'normal') canvas = downscaleToMax(canvas, 1000);
  // JPG can't hold transparency: flatten onto white if no color chosen.
  let format = state.format;
  if (format === 'image/jpeg' && (state.bgColor === 'transparent' || !state.bgColor)) {
    canvas = flattenOnWhite(canvas);
  }
  // Lower JPEG quality a touch in Normal mode to keep files small.
  const jpegQuality = state.quality === 'normal' ? 0.82 : 0.92;
  const blob = await canvasToBlob(canvas, format, jpegQuality);
  if (item.renderGen !== gen) return; // superseded by a newer render — drop it
  if (!blob) throw new Error('Could not export image (size may be too large).');
  if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
  item.resultBlob = blob;
  item.resultUrl = URL.createObjectURL(blob);
  updateCard(item);
}

/* Re-render all finished items when an option changes (live preview). */
let reRenderTimer = null;
function reRenderIfDone() {
  const myRun = state.runId;
  const done = state.items.filter((i) => i.cutout);
  if (!done.length) return;
  clearTimeout(reRenderTimer);
  reRenderTimer = setTimeout(async () => {
    for (const item of done) {
      if (myRun !== state.runId) return;         // cleared — stop touching detached items
      if (!state.items.includes(item)) continue; // this item was removed
      try {
        await renderResult(item);
      } catch (err) {
        console.error('[re-render]', item.name, err);
        item.status = 'error';
        item.error = 'Bad size/options';
        updateCard(item);
      }
    }
  }, 120);
}

/* ---------- Rendering the results grid ---------- */
function renderCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.id = `card-${item.id}`;
  card.innerHTML = `
    <div class="card-thumb checker">
      <img alt="${escapeHtml(item.name)}" />
      <div class="card-badge" hidden></div>
      <div class="card-status"><div class="mini-spin"></div><span>Queued…</span></div>
    </div>
    <div class="card-body">
      <span class="card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
      <a class="card-dl" hidden>Save</a>
    </div>`;
  resultsEl.appendChild(card);
}

function updateCard(item) {
  const card = document.getElementById(`card-${item.id}`);
  if (!card) return;
  const img = card.querySelector('img');
  const statusEl = card.querySelector('.card-status');
  const badge = card.querySelector('.card-badge');
  const dl = card.querySelector('.card-dl');

  // Thumbnail: show result if ready, else original thumb.
  if (item.resultUrl) { img.src = item.resultUrl; }
  else if (item.thumb) { img.src = item.thumb; }

  // Status overlay.
  const map = {
    queued:     { show: true,  cls: '', html: '<div class="mini-spin"></div><span>Waiting…</span>' },
    processing: { show: true,  cls: '', html: '<div class="mini-spin"></div><span>Removing…</span>' },
    done:       { show: false },
    error:      { show: true,  cls: 'error', html: `<span>⚠ ${escapeHtml(item.error || 'Error')}</span>` },
  };
  const s = map[item.status] || map.queued;
  statusEl.className = 'card-status' + (s.cls ? ' ' + s.cls : '') + (s.show ? '' : ' hidden');
  if (s.show && s.html) statusEl.innerHTML = s.html;

  // Badge + download (only once a result URL actually exists).
  if (item.status === 'done' && item.resultUrl) {
    badge.hidden = false; badge.textContent = 'Done';
    dl.hidden = false;
    dl.href = item.resultUrl;
    dl.download = outName(item.name, state.format);
  } else {
    badge.hidden = true; dl.hidden = true;
  }
  // Mark finished cards so CSS can offer a zoom-in cursor on the thumbnail.
  card.classList.toggle('is-done', item.status === 'done' && !!item.resultUrl);
}

/* ---------- Download gate (single image free · 2+ images need a serial key) ---------- */
function doneCount() {
  return state.items.filter((i) => i.status === 'done' && i.resultBlob).length;
}

/* Allowed to download right now? A single image is free; 2+ need a valid key.
   Only enforced once Firebase is configured — an un-configured deploy stays open. */
async function ensureUnlocked() {
  if (doneCount() <= 1) return true;   // single image → always free
  if (!isConfigured()) return true;    // gate not set up yet → open
  if (state.unlocked) return stillValid();  // periodically re-check the saved key
  return openKeyModal();
}

/* Cheaply decide whether an unlocked key is still good. Fast-returns true unless
   it looks expired or REVERIFY_MS has passed since the last check — then re-verifies. */
async function stillValid() {
  const now = Date.now();
  const expired = state.keyExpiry != null && now > state.keyExpiry;
  const stale = now - state.lastVerify > REVERIFY_MS;
  if (!expired && !stale) return true;
  return revalidate();
}

/* Re-run the full server verify for the saved key. ok → refresh + stay unlocked.
   Genuinely invalid → forget the key and re-open the modal. Transient (offline)
   → keep access (lenient, so a network blip never locks out a paying user). */
async function revalidate() {
  let saved = '';
  try { saved = localStorage.getItem(KEY_STORAGE) || ''; } catch (_) {}
  if (!saved) { state.unlocked = false; return openKeyModal(); }
  let res;
  try { res = await verifyKey(saved); }
  catch (_) { return true; }        // network error → lenient
  if (res.ok) {
    state.keyExpiry = res.expiresAt || null;
    state.lastVerify = Date.now();
    return true;
  }
  if (res.transient) return true;   // offline → lenient
  // Genuinely invalid now (expired / disabled / device reset by an admin).
  state.unlocked = false;
  state.keyExpiry = null;
  state.lastVerify = 0;
  try { localStorage.removeItem(KEY_STORAGE); } catch (_) {}
  toast(res.reason || 'Your key is no longer valid.', 'error');
  return openKeyModal();
}

let keyModalResolve = null;
let keyModalLastFocus = null;
function openKeyModal() {
  const modal = $('#keyModal');
  if (!modal) return Promise.resolve(false);
  // Re-entrancy guard: if a previous unlock is still pending, resolve it as
  // cancelled so its awaiter can't hang when we overwrite the resolver slot.
  if (keyModalResolve) { keyModalResolve(false); keyModalResolve = null; }
  keyModalLastFocus = document.activeElement; // restore focus here on close (a11y)
  const input = $('#keyInput');
  const err = $('#keyError');
  err.hidden = true; err.textContent = '';
  input.value = '';
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => input.focus(), 30);
  return new Promise((resolve) => { keyModalResolve = resolve; });
}
function closeKeyModal(result) {
  const modal = $('#keyModal');
  if (modal) modal.hidden = true;
  // Only release the scroll-lock if the lightbox isn't also holding it.
  const lb = $('#lightbox');
  if (!lb || lb.hidden) document.body.style.overflow = '';
  if (keyModalResolve) { keyModalResolve(result); keyModalResolve = null; }
  // Return focus to whatever the user was on before the modal opened.
  if (keyModalLastFocus && keyModalLastFocus.focus) { try { keyModalLastFocus.focus(); } catch (_) {} }
  keyModalLastFocus = null;
}
function bindKeyModal() {
  const modal = $('#keyModal');
  if (!modal) return;
  const input = $('#keyInput');
  const err = $('#keyError');
  const verify = $('#keyVerifyBtn');

  const doVerify = async () => {
    err.hidden = true;
    const orig = verify.textContent;
    verify.disabled = true; verify.textContent = 'Checking…';
    let res;
    try { res = await verifyKey(input.value); }
    catch (_) { res = { ok: false, reason: 'Could not verify. Please try again.' }; }
    verify.disabled = false; verify.textContent = orig;
    if (res.ok) {
      state.unlocked = true;
      state.keyExpiry = res.expiresAt || null;
      state.lastVerify = Date.now();
      // Remember the key so it doesn't need re-entering next visit.
      try { localStorage.setItem(KEY_STORAGE, (input.value || '').trim().toUpperCase()); } catch (_) {}
      toast('Unlocked — thank you!', 'success');
      closeKeyModal(true);
    } else {
      err.textContent = res.reason || 'Invalid key.';
      err.hidden = false;
      input.focus(); input.select();
    }
  };

  verify.addEventListener('click', doVerify);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doVerify(); } });
  modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => closeKeyModal(false)));
  modal.addEventListener('click', (e) => { if (e.target === modal) closeKeyModal(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeKeyModal(false); });

  // Keep Tab focus inside the dialog while it's open (a11y — a modal shouldn't
  // let keyboard focus wander back to the page behind it).
  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || modal.hidden) return;
    const focusable = modal.querySelectorAll('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])');
    const list = [...focusable].filter((el) => el.offsetParent !== null);
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
function fillSupport() {
  const emailEl = $('#supportEmail');
  if (emailEl && SUPPORT_CONTACT.email) {
    emailEl.href = 'mailto:' + SUPPORT_CONTACT.email;
    emailEl.textContent = SUPPORT_CONTACT.email;
  }
  const waEl = $('#supportWhatsapp');
  if (waEl) {
    if (SUPPORT_CONTACT.whatsapp) {
      waEl.href = SUPPORT_CONTACT.whatsapp;
      if (SUPPORT_CONTACT.whatsappLabel) waEl.textContent = ' · WhatsApp: ' + SUPPORT_CONTACT.whatsappLabel;
      waEl.hidden = false;
    } else { waEl.hidden = true; }
  }
}

/* ---------- Lightbox — tap a finished result to view it full-size ---------- */
let lightboxLastFocus = null;
function openLightbox(url, name) {
  const lb = $('#lightbox');
  const img = $('#lightboxImg');
  if (!lb || !img) return;
  lightboxLastFocus = document.activeElement;
  img.src = url;
  img.alt = name ? `Preview: ${name}` : 'Result preview';
  lb.hidden = false;
  document.body.style.overflow = 'hidden';
  const closeBtn = lb.querySelector('[data-close]');
  setTimeout(() => { if (closeBtn) closeBtn.focus(); }, 30);
}
function closeLightbox() {
  const lb = $('#lightbox');
  if (!lb || lb.hidden) return;
  lb.hidden = true;
  const img = $('#lightboxImg');
  if (img) img.removeAttribute('src'); // drop the (possibly large) preview image
  // Only release the scroll-lock if the key modal isn't also holding it.
  const keyModal = $('#keyModal');
  if (!keyModal || keyModal.hidden) document.body.style.overflow = '';
  if (lightboxLastFocus && lightboxLastFocus.focus) { try { lightboxLastFocus.focus(); } catch (_) {} }
  lightboxLastFocus = null;
}
function bindLightbox() {
  const lb = $('#lightbox');
  if (!lb) return;
  lb.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeLightbox));
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lb.hidden) closeLightbox(); });
}

/* ---------- Download all as ZIP ---------- */
async function downloadAllZip() {
  const done = state.items.filter((i) => i.status === 'done' && i.resultBlob);
  if (!done.length) { toast('Nothing to download yet.', 'error'); return; }
  if (done.length === 1) { // single file → direct save (always free)
    triggerDownload(done[0].resultUrl, outName(done[0].name, state.format));
    return;
  }
  if (!(await ensureUnlocked())) return; // 2+ images require a valid serial key
  downloadAllBtn.disabled = true;
  const orig = downloadAllBtn.textContent;
  downloadAllBtn.textContent = 'Zipping…';
  try {
    const { default: JSZip } = await import(/* @vite-ignore */ JSZIP_URL);
    const zip = new JSZip();
    const used = {};
    for (const item of done) {
      let fname = outName(item.name, state.format);
      if (used[fname]) fname = fname.replace(/(\.\w+)$/, `-${used[fname]++}$1`);
      else used[fname] = 1;
      zip.file(fname, item.resultBlob);
    }
    const blob = await zip.generateAsync({ type: 'blob' }, (meta) => {
      downloadAllBtn.textContent = `Zipping… ${Math.round(meta.percent)}%`;
    });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, 'BulkBGRemover-photos.zip');
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`Downloaded ${done.length} photos as ZIP.`, 'success');
  } catch (err) {
    console.error(err);
    toast('Could not build ZIP. Save images individually.', 'error');
  } finally {
    downloadAllBtn.disabled = false;
    downloadAllBtn.textContent = orig;
  }
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- Clear ---------- */
function clearAll() {
  state.runId++;               // abort any in-flight processAll / re-render loop
  clearTimeout(reRenderTimer); // cancel a pending live re-render
  reRenderTimer = null;
  state.items.forEach((i) => { if (i.resultUrl) URL.revokeObjectURL(i.resultUrl); });
  state.items = [];
  state.processing = false;    // release the lock (Clear during processing = cancel)
  state.warnedLargeBatch = false;
  resultsEl.innerHTML = '';
  downloadAllBtn.hidden = true;
  if (batchStatus) batchStatus.hidden = true;
  processPanel.hidden = false;
  if (fileInput) fileInput.value = ''; // allow re-adding the exact same file
  processBtn.querySelector('.btn-label').textContent = 'Remove backgrounds';
  updateProcessButton();
}

/* ---------- Toast ---------- */
let toastWrap;
function toast(msg, type = '') {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    document.body.appendChild(toastWrap);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  toastWrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2600);
}

/* ---------- utils ---------- */
/* Resolve the state item that owns a given element (via its .card ancestor). */
function itemFromEl(el) {
  const card = el.closest('.card');
  const id = card ? +card.id.replace('card-', '') : 0;
  return state.items.find((i) => i.id === id) || null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- go ---------- */
init();
