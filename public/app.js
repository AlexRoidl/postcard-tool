/* Postcard Printer — editor.
 * 4x6" postcard composer with per-image transform + dithering, printed to a
 * Phomemo (AirPrint) via the local server, popup-free.
 */
'use strict';

// ---------- format / resolution ----------
let DPI = 300;
let ORIENT = 'landscape';            // 'landscape' = 6x4, 'portrait' = 4x6
const INCH_LONG = 6, INCH_SHORT = 4;
let OUT_W = 1800, OUT_H = 1200;      // full-res output pixels (recomputed)
const PREVIEW_LONG = 840;            // longest preview side in backing px
let renderScale = 1;                 // output px -> preview canvas px

const board = document.getElementById('board');
const ctx = board.getContext('2d');
const COARSE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);  // touch device
const pointers = new Map();           // active pointers on the board (for pinch)

// ---------- state ----------
let assets = [];                     // uploaded image library (left strip)
let layers = [];                     // canvas placements, bottom -> top
let selId = null;
let uid = 1;

function selected() { return layers.find(l => l.id === selId) || null; }

// ---------- lp print options (editable, persisted) ----------
// PM643 driver: 4x6" label = CUPS page size w288h432 (288x432pt), 300dpi.
// We send a pixel-exact portrait image, so no fit/rotate options are needed.
const LP_DEFAULTS = {
  landscape: '-o PageSize=w288h432 -o print-color-mode=monochrome',
  portrait:  '-o PageSize=w288h432 -o print-color-mode=monochrome',
};
function lpOptionString() {
  const key = 'lpopts_' + ORIENT;
  return localStorage.getItem(key) || LP_DEFAULTS[ORIENT];
}
function setLpOptionString(v) { localStorage.setItem('lpopts_' + ORIENT, v); }

// =====================================================================
//  FORMAT
// =====================================================================
function applyFormat() {
  const longPx = Math.round(INCH_LONG * DPI);
  const shortPx = Math.round(INCH_SHORT * DPI);
  if (ORIENT === 'landscape') { OUT_W = longPx; OUT_H = shortPx; }
  else { OUT_W = shortPx; OUT_H = longPx; }

  const scale = PREVIEW_LONG / Math.max(OUT_W, OUT_H);
  board.width = Math.round(OUT_W * scale);
  board.height = Math.round(OUT_H * scale);
  renderScale = board.width / OUT_W;

  layers.forEach(l => { l._bakeKey = null; });  // force rebake at new scale
  fitCanvas();
  render();
}

// Fit the canvas into the stage, leaving room for the floating controls.
function fitCanvas() {
  const stage = document.getElementById('stage');
  const mobile = window.innerWidth < 560;
  const availW = stage.clientWidth - (mobile ? 78 : 200);   // clear of thumb strip + margins
  const availH = stage.clientHeight - (mobile ? 206 : 170); // clear of top + bottom bars
  const s = Math.max(0.05, Math.min(availW / board.width, availH / board.height));
  board.style.width = board.width * s + 'px';
  board.style.height = board.height * s + 'px';
}

function updateOrientBtn() {
  document.getElementById('orientBtn').textContent = ORIENT === 'landscape' ? '6×4' : '4×6';
}

// =====================================================================
//  IMAGE INPUT
// =====================================================================
// Uploading adds the image to the left library (it stays there);
// clicking a library item places it on the canvas (as many times as you like).
function addAssetFromSrc(src, name) {
  const img = new Image();
  img.onload = () => {
    const asset = { id: uid++, src, img, name: name || `Image ${assets.length + 1}` };
    assets.push(asset);
    renderThumbs();
    addLayerFromAsset(asset);   // also place it on the canvas immediately
  };
  img.onerror = () => toast('Could not load image', true);
  img.src = src;
}

function addLayerFromAsset(asset) {
  if (!asset.img || !asset.img.naturalHeight) return;
  // fit new placement to ~60% of the short side
  const scale = (OUT_H * 0.6) / asset.img.naturalHeight;
  const layer = {
    id: uid++, assetId: asset.id, name: asset.name,
    src: asset.src, img: asset.img, visible: true,
    x: OUT_W / 2, y: OUT_H / 2,
    scale, rot: 0, opacity: 1,
    // default: no dithering (full colour). Toggle it on per image via the dither button.
    dither: { enabled: false, algo: 'floyd', brightness: 0, contrast: 0, invert: false },
    _baked: null, _bakeKey: null,
  };
  layers.push(layer);
  selId = layer.id;
  renderThumbs(); syncBar(); render();
}

function handleFiles(files) {
  [...files].filter(f => f.type.startsWith('image/')).forEach(f => {
    const r = new FileReader();
    r.onload = e => addAssetFromSrc(e.target.result, f.name.replace(/\.[^.]+$/, ''));
    r.readAsDataURL(f);
  });
}

// =====================================================================
//  DITHERING / BAKING
// =====================================================================
const BAYER4 = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
].map(r => r.map(v => (v + 0.5) / 16 * 255));

function adjust(data, layer) {
  const b = layer.dither.brightness;
  const c = layer.dither.contrast;
  const cf = (259 * (c + 255)) / (255 * (259 - c)); // contrast factor
  const inv = layer.dither.invert;
  for (let i = 0; i < data.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      let v = data[i + k];
      v = cf * (v - 128) + 128 + b;
      if (inv) v = 255 - v;
      data[i + k] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}

// Convert ImageData in place to 1-bit black-on-transparent via chosen algorithm.
function dither1bit(id, algo) {
  const { data, width: w, height: h } = id;
  const n = w * h;
  const gray = new Float32Array(n);
  const op = new Uint8Array(n); // opaque mask
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    op[i] = a > 40 ? 1 : 0;
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  const on = new Uint8Array(n);
  if (algo === 'threshold') {
    for (let i = 0; i < n; i++) on[i] = gray[i] < 128 ? 1 : 0;
  } else if (algo === 'bayer') {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        on[i] = gray[i] < BAYER4[y & 3][x & 3] ? 1 : 0;
      }
  } else {
    // error diffusion (floyd / atkinson)
    const push = (x, y, err, f) => {
      if (x < 0 || x >= w || y < 0 || y >= h) return;
      gray[y * w + x] += err * f;
    };
    const atk = algo === 'atkinson';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = gray[i];
        const nv = old < 128 ? 0 : 255;
        on[i] = nv === 0 ? 1 : 0;
        const err = old - nv;
        if (atk) {
          const e = err / 8;
          push(x + 1, y, e, 1); push(x + 2, y, e, 1);
          push(x - 1, y + 1, e, 1); push(x, y + 1, e, 1); push(x + 1, y + 1, e, 1);
          push(x, y + 2, e, 1);
        } else {
          push(x + 1, y, err, 7 / 16);
          push(x - 1, y + 1, err, 3 / 16);
          push(x, y + 1, err, 5 / 16);
          push(x + 1, y + 1, err, 1 / 16);
        }
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const ink = op[i] && on[i];
    data[i * 4] = 0; data[i * 4 + 1] = 0; data[i * 4 + 2] = 0;
    data[i * 4 + 3] = ink ? 255 : 0;
  }
}

function bakeKey(layer, scale) {
  const d = layer.dither;
  return [scale.toFixed(4), layer.scale.toFixed(4), d.enabled, d.algo, d.brightness, d.contrast, d.invert, layer.src.length].join('|');
}

// Returns a canvas of the layer rendered at its footprint size for `scale`.
function getBaked(layer, scale, useCache = true) {
  const key = bakeKey(layer, scale);
  if (useCache && layer._baked && layer._bakeKey === key) return layer._baked;

  const img = layer.img;
  let bw = Math.max(1, Math.round(img.naturalWidth * layer.scale * scale));
  let bh = Math.max(1, Math.round(img.naturalHeight * layer.scale * scale));
  // Cap bake resolution for perf / canvas safety only; geometry is handled at draw time so a
  // capped bake no longer changes the printed size. High enough to keep full-res dither crisp.
  const cap = 4096;
  const m = Math.max(bw, bh);
  if (m > cap) { const r = cap / m; bw = Math.round(bw * r); bh = Math.round(bh * r); }

  const c = document.createElement('canvas');
  c.width = bw; c.height = bh;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.drawImage(img, 0, 0, bw, bh);
  const id = g.getImageData(0, 0, bw, bh);
  adjust(id.data, layer);
  if (layer.dither.enabled) dither1bit(id, layer.dither.algo);
  g.putImageData(id, 0, 0);

  if (useCache) { layer._baked = c; layer._bakeKey = key; }
  return c;
}

// =====================================================================
//  RENDER
// =====================================================================
function composite(targetCtx, scale, useCache) {
  targetCtx.setTransform(1, 0, 0, 1, 0, 0);
  targetCtx.clearRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
  targetCtx.fillStyle = '#fff';
  targetCtx.fillRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);

  for (const layer of layers) {
    if (!layer.visible || !layer.img) continue;
    const b = getBaked(layer, scale, useCache);
    // Draw at the intended footprint, NOT the baked bitmap's own pixel size. The bake may be
    // resolution-capped (for perf / canvas limits); decoupling keeps size identical between the
    // low-res preview and the full-res print.
    const fw = layer.img.naturalWidth * layer.scale * scale;
    const fh = layer.img.naturalHeight * layer.scale * scale;
    targetCtx.save();
    targetCtx.globalAlpha = layer.opacity;
    targetCtx.translate(layer.x * scale, layer.y * scale);
    targetCtx.rotate(layer.rot * Math.PI / 180);
    targetCtx.imageSmoothingEnabled = !layer.dither.enabled;
    targetCtx.drawImage(b, -fw / 2, -fh / 2, fw, fh);
    targetCtx.restore();
  }
}

function render() {
  composite(ctx, renderScale, true);
  drawSelection();
  scheduleSave();
}

// selection box + handles in preview canvas px
function layerCorners(layer) {
  const w = layer.img.naturalWidth * layer.scale * renderScale;
  const h = layer.img.naturalHeight * layer.scale * renderScale;
  const cx = layer.x * renderScale, cy = layer.y * renderScale;
  const a = layer.rot * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  return pts.map(([x, y]) => ({ x: cx + x * cos - y * sin, y: cy + x * sin + y * cos }));
}

// Scale-independent corner offset (OUT units) from the layer centre, in local (unrotated)
// space. Corner order matches layerCorners(): 0 TL, 1 TR, 2 BR, 3 BL.
function cornerLocalUnit(layer, k) {
  const hw = layer.img.naturalWidth / 2, hh = layer.img.naturalHeight / 2;
  return { x: (k === 1 || k === 2) ? hw : -hw, y: (k === 2 || k === 3) ? hh : -hh };
}

function rotateHandle(layer) {
  const c = layerCorners(layer);
  const topMid = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 };
  const a = layer.rot * Math.PI / 180;
  return { x: topMid.x + Math.sin(a) * 26, y: topMid.y - Math.cos(a) * 26, topMid };
}

function drawSelection() {
  const layer = selected();
  if (!layer || !layer.img) return;
  const c = layerCorners(layer);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const px2 = board.width / (board.getBoundingClientRect().width || board.width);
  const hs = (COARSE ? 10 : 4) * px2;   // square-handle half size (≈ constant CSS px)
  const rr = (COARSE ? 10 : 5) * px2;   // rotate-knob radius
  ctx.lineWidth = (COARSE ? 2 : 1.5) * px2;
  ctx.strokeStyle = '#200010';
  ctx.beginPath();
  ctx.moveTo(c[0].x, c[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
  ctx.closePath();
  ctx.stroke();

  const rh = rotateHandle(layer);
  ctx.beginPath(); ctx.moveTo(rh.topMid.x, rh.topMid.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();
  // handles
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#200010';
  c.forEach(p => { ctx.beginPath(); ctx.rect(p.x - hs, p.y - hs, hs * 2, hs * 2); ctx.fill(); ctx.stroke(); });
  ctx.beginPath(); ctx.arc(rh.x, rh.y, rr, 0, 7); ctx.fill(); ctx.stroke();
}

// =====================================================================
//  THUMBNAIL STRIP (left — the images you added; top layer first)
// =====================================================================
// The left strip is the image LIBRARY (uploaded images), not the canvas layers.
// Click a thumb to place it on the canvas; the ✕ removes it from the session.
function renderThumbs() {
  const box = document.getElementById('thumbs');
  box.innerHTML = '';
  const selAsset = selected()?.assetId;
  assets.forEach(asset => {
    const d = document.createElement('div');
    d.className = 'thumb' + (asset.id === selAsset ? ' sel' : '');
    d.title = 'Click to add to the canvas';
    const im = document.createElement('img');
    im.src = asset.src;
    d.appendChild(im);
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '✕'; del.title = 'Remove from session';
    del.addEventListener('click', e => { e.stopPropagation(); removeAsset(asset.id); });
    d.appendChild(del);
    d.addEventListener('click', () => addLayerFromAsset(asset));
    box.appendChild(d);
  });
}

// Delete a single canvas placement — the image stays in the library.
function removeLayer(id) {
  layers = layers.filter(l => l.id !== id);
  if (selId === id) selId = layers.length ? layers[layers.length - 1].id : null;
  renderThumbs(); syncBar(); render();
}

// Delete an uploaded image from the session entirely (library + any placements).
function removeAsset(id) {
  assets = assets.filter(a => a.id !== id);
  layers = layers.filter(l => l.assetId !== id);
  if (!layers.find(l => l.id === selId)) selId = layers.length ? layers[layers.length - 1].id : null;
  renderThumbs(); syncBar(); render();
}

// =====================================================================
//  BOTTOM BAR (controls for the selected image)
// =====================================================================
const DITHER_CYCLE = ['floyd', 'atkinson', 'bayer', 'threshold', 'off'];
const DITHER_LABEL = { floyd: 'floyd', atkinson: 'atkinson', bayer: 'bayer', threshold: 'threshold', off: 'no dither' };
function ditherState(layer) { return layer.dither.enabled ? layer.dither.algo : 'off'; }
function cycleDither(layer) {
  const cur = ditherState(layer);
  const next = DITHER_CYCLE[(DITHER_CYCLE.indexOf(cur) + 1) % DITHER_CYCLE.length];
  if (next === 'off') layer.dither.enabled = false;
  else { layer.dither.enabled = true; layer.dither.algo = next; }
}

function syncBar() {
  const layer = selected();
  document.getElementById('imgbar').hidden = !layer;
  if (!layer) return;
  document.getElementById('ditherBtn').textContent = DITHER_LABEL[ditherState(layer)];
  document.getElementById('invertBtn').classList.toggle('on', layer.dither.invert);
  set('brightness', layer.dither.brightness);
  set('contrast', layer.dither.contrast);
  set('opacity', layer.opacity);
}
function set(id, v) { const el = document.getElementById(id); if (el && el.tagName !== 'SPAN') el.value = v; }

function bindBar() {
  const L = () => selected();
  document.getElementById('ditherBtn').addEventListener('click', () => { if (L()) { cycleDither(L()); syncBar(); render(); } });
  document.getElementById('invertBtn').addEventListener('click', () => { if (L()) { L().dither.invert = !L().dither.invert; syncBar(); render(); } });
  document.getElementById('brightness').addEventListener('input', e => { if (L()) { L().dither.brightness = +e.target.value; render(); } });
  document.getElementById('contrast').addEventListener('input', e => { if (L()) { L().dither.contrast = +e.target.value; render(); } });
  document.getElementById('opacity').addEventListener('input', e => { if (L()) { L().opacity = +e.target.value; render(); } });

  document.querySelectorAll('#imgbar [data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const layer = L(); if (!layer) return;
      const i = layers.indexOf(layer);
      if (btn.dataset.act === 'front') { layers.splice(i, 1); layers.push(layer); }
      if (btn.dataset.act === 'back') { layers.splice(i, 1); layers.unshift(layer); }
      if (btn.dataset.act === 'del') { removeLayer(layer.id); return; }
      renderThumbs(); render();
    });
  });
}

// =====================================================================
//  CANVAS INTERACTION
// =====================================================================
let drag = null;

function toCanvasPx(e) {
  const r = board.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * board.width, y: (e.clientY - r.top) / r.height * board.height };
}
function toOut(p) { return { x: p.x / renderScale, y: p.y / renderScale }; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function hitLayer(outPt) {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.visible || !l.img) continue;
    const a = -l.rot * Math.PI / 180;
    const dx = outPt.x - l.x, dy = outPt.y - l.y;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    const w = l.img.naturalWidth * l.scale / 2, h = l.img.naturalHeight * l.scale / 2;
    if (Math.abs(lx) <= w && Math.abs(ly) <= h) return l;
  }
  return null;
}

board.addEventListener('pointerdown', e => {
  board.setPointerCapture(e.pointerId);
  const cpx = toCanvasPx(e);
  pointers.set(e.pointerId, cpx);

  // two fingers on the selected image → pinch to scale & rotate
  if (pointers.size === 2 && selected()) {
    const [p1, p2] = [...pointers.values()];
    const l = selected();
    drag = { mode: 'pinch', d0: dist(p1, p2) || 1, a0: Math.atan2(p2.y - p1.y, p2.x - p1.x), s0: l.scale, rot0: l.rot };
    return;
  }

  const layer = selected();
  const px2 = board.width / (board.getBoundingClientRect().width || board.width);
  const tol = (e.pointerType === 'touch' ? 26 : 11) * px2;   // finger-sized grab radius
  if (layer && layer.img) {
    const corners = layerCorners(layer);
    const rh = rotateHandle(layer);
    if (dist(cpx, rh) < tol) {
      const a0 = Math.atan2(cpx.y - layer.y * renderScale, cpx.x - layer.x * renderScale);
      drag = { mode: 'rotate', a0, rot0: layer.rot }; return;
    }
    for (let ci = 0; ci < corners.length; ci++) {
      if (dist(cpx, corners[ci]) < tol) {
        // scale from the OPPOSITE corner — it stays pinned while this handle moves
        const opp = (ci + 2) % 4;
        const anchorOut = { x: corners[opp].x / renderScale, y: corners[opp].y / renderScale };
        drag = { mode: 'scale', opp, anchorOut, s0: layer.scale, d0: dist(cpx, corners[opp]) || 1, rot0: layer.rot };
        return;
      }
    }
  }

  const out = toOut(cpx);
  const hit = hitLayer(out);
  if (hit) {
    selId = hit.id; renderThumbs(); syncBar(); render();
    drag = { mode: 'move', start: out, x0: hit.x, y0: hit.y };
  } else {
    selId = null; renderThumbs(); syncBar(); render();
  }
});

board.addEventListener('pointermove', e => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, toCanvasPx(e));
  if (!drag) return;
  const layer = selected(); if (!layer) return;

  if (drag.mode === 'pinch') {
    const pts = [...pointers.values()];
    if (pts.length < 2) return;
    const [p1, p2] = pts;
    const d = dist(p1, p2), a = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    layer.scale = Math.max(0.02, Math.min(8, drag.s0 * (d / drag.d0)));
    layer.rot = drag.rot0 + (a - drag.a0) * 180 / Math.PI;
    while (layer.rot > 180) layer.rot -= 360; while (layer.rot < -180) layer.rot += 360;
    render(); return;
  }

  const cpx = toCanvasPx(e);
  if (drag.mode === 'move') {
    const out = toOut(cpx);
    layer.x = drag.x0 + (out.x - drag.start.x);
    layer.y = drag.y0 + (out.y - drag.start.y);
  } else if (drag.mode === 'scale') {
    const anchorPx = { x: drag.anchorOut.x * renderScale, y: drag.anchorOut.y * renderScale };
    layer.scale = Math.max(0.02, Math.min(8, drag.s0 * (dist(cpx, anchorPx) / drag.d0)));
    // reposition the centre so the opposite (anchor) corner stays exactly put
    const u = cornerLocalUnit(layer, drag.opp);
    const a = drag.rot0 * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    layer.x = drag.anchorOut.x - layer.scale * (u.x * cos - u.y * sin);
    layer.y = drag.anchorOut.y - layer.scale * (u.x * sin + u.y * cos);
  } else if (drag.mode === 'rotate') {
    const a = Math.atan2(cpx.y - layer.y * renderScale, cpx.x - layer.x * renderScale);
    layer.rot = drag.rot0 + (a - drag.a0) * 180 / Math.PI;
    while (layer.rot > 180) layer.rot -= 360; while (layer.rot < -180) layer.rot += 360;
  }
  render();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (drag && (drag.mode !== 'pinch' || pointers.size < 2)) drag = null;
}
board.addEventListener('pointerup', endPointer);
board.addEventListener('pointercancel', endPointer);

// wheel = scale selected
board.addEventListener('wheel', e => {
  const layer = selected(); if (!layer) return;
  e.preventDefault();
  layer.scale = Math.max(0.02, Math.min(8, layer.scale * (1 - e.deltaY * 0.0012)));
  render();
}, { passive: false });

// keyboard
window.addEventListener('keydown', e => {
  const layer = selected();
  if (e.key === 'Escape') { selId = null; renderThumbs(); syncBar(); render(); return; }
  if (!layer) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && e.target.tagName !== 'INPUT') { removeLayer(layer.id); e.preventDefault(); return; }
  const step = e.shiftKey ? 10 : 2;
  if (e.key === 'ArrowLeft') { layer.x -= step; render(); e.preventDefault(); }
  if (e.key === 'ArrowRight') { layer.x += step; render(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { layer.y -= step; render(); e.preventDefault(); }
  if (e.key === 'ArrowDown') { layer.y += step; render(); e.preventDefault(); }
});

// =====================================================================
//  OUTPUT (full-res render for print / export)
// =====================================================================
function renderFullRes() {
  const c = document.createElement('canvas');
  c.width = OUT_W; c.height = OUT_H;
  composite(c.getContext('2d'), 1, false); // bake at full res, no cache
  return c;
}

function exportPNG() {
  const url = renderFullRes().toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url; a.download = `postcard_${Date.now()}.png`; a.click();
}

// Build the exact image sent to the printer: always the label's native PORTRAIT
// grid (short side = width, long side = height). A landscape design is rotated 90°
// so a 6x4 postcard fills a 4x6 label with no scaling.
function buildPrintCanvas() {
  const full = renderFullRes();                 // OUT_W x OUT_H in current orientation
  const shortPx = Math.round(INCH_SHORT * DPI); // 4"
  const longPx = Math.round(INCH_LONG * DPI);   // 6"
  const c = document.createElement('canvas');
  c.width = shortPx; c.height = longPx;         // portrait label
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  if (ORIENT === 'portrait') {
    g.drawImage(full, 0, 0, c.width, c.height);
  } else {
    g.translate(c.width, 0); g.rotate(Math.PI / 2);
    g.drawImage(full, 0, 0, longPx, shortPx);   // landscape (longxshort) into rotated frame
  }
  return c;
}

async function print() {
  const printer = document.getElementById('printerSelect').value;
  if (!printer) { toast('No printer selected — click ⟳ or + WiFi', true); return; }
  if (!layers.length) { toast('Add an image first', true); return; }
  toast('Rendering & sending to ' + printer + ' …');
  const dataURL = buildPrintCanvas().toDataURL('image/png');
  const lpOptions = lpOptionString().trim().split(/\s+/);
  try {
    const res = await fetch('/api/print', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataURL, printer, lpOptions }),
    });
    const j = await res.json();
    if (j.ok) toast('Sent to printer ✓ ' + (j.job || ''));
    else toast('Print failed: ' + (j.error || 'unknown'), true);
  } catch (err) { toast('Print error: ' + err.message, true); }
}

// =====================================================================
//  MODE: local (direct print) vs queue (submit to the workshop server)
// =====================================================================
let CONFIG = { role: 'local', roomRequired: false };

async function fetchConfig() {
  try { const r = await fetch('/api/config'); if (r.ok) CONFIG = await r.json(); } catch (_) {}
  applyMode();
}

function applyMode() {
  const btn = document.getElementById('printBtn');
  const ni = document.getElementById('nameInput');
  if (CONFIG.role === 'queue') {
    btn.textContent = 'send to print';
    // participants don't pick printers — hide the gear, show the name field
    const gear = document.getElementById('settingsBtn');
    if (gear) gear.style.display = 'none';
    if (ni) ni.hidden = false;
  } else {
    btn.textContent = 'print';
    if (ni) ni.hidden = true;
    loadPrinters();
  }
}

function onPrintClick() { if (CONFIG.role === 'queue') submitJob(); else print(); }

// Submit the finished design to the workshop print queue (eduroam-safe: outbound only).
async function submitJob() {
  if (!layers.length) { toast('Add an image first', true); return; }
  let room = '';
  if (CONFIG.roomRequired) {
    room = localStorage.getItem('room_code') || '';
    if (!room) { room = (prompt('Workshop code (from the facilitator):') || '').trim(); if (!room) return; localStorage.setItem('room_code', room); }
  }
  const name = (document.getElementById('nameInput')?.value || '').trim(); // optional
  toast('Sending to the print queue …');
  const dataURL = buildPrintCanvas().toDataURL('image/png');
  const lpOptions = lpOptionString().trim().split(/\s+/);
  try {
    const res = await fetch('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataURL, lpOptions, orient: ORIENT, name, room }),
    });
    const j = await res.json();
    if (j.ok) toast('Sent to print queue ✓ — the facilitator will print it');
    else {
      toast('Submit failed: ' + (j.error || 'unknown'), true);
      if (/room/i.test(j.error || '')) localStorage.removeItem('room_code'); // let them re-enter the code
    }
  } catch (err) { toast('Submit error: ' + err.message, true); }
}

// =====================================================================
//  PRINTERS
// =====================================================================
async function loadPrinters(selectPref) {
  const sel = document.getElementById('printerSelect');
  try {
    const r = await fetch('/api/printers');
    const j = await r.json();
    sel.innerHTML = '';
    const mk = (name, label) => { const o = document.createElement('option'); o.value = name; o.textContent = label; sel.appendChild(o); };
    const printers = j.printers || [];
    // prioritise the real Phomemo queue; a leading "_" marks a generic temp queue, so rank it lower
    const score = p => (/pm643|phomemo/i.test(p.name) ? 2 : 0) + (p.name.startsWith('_') ? 0 : 1);
    printers.sort((a, b) => score(b) - score(a));
    printers.forEach(p => mk(p.name, `${p.name}${p.kind === 'network' ? ' · wifi' : p.kind === 'usb' ? ' · usb' : ''}${p.state === 'disabled' ? ' (off)' : ''}`));
    if (!printers.length) mk('', 'No printers found');
    const pref = selectPref
      || printers.find(p => /pm643_usb/i.test(p.name))?.name          // the stable permanent queue that works
      || printers.find(p => /pm643|phomemo/i.test(p.name) && !p.name.startsWith('_'))?.name
      || printers.find(p => /pm643|phomemo/i.test(p.name))?.name
      || j.defaultName;
    if (pref) sel.value = pref;
  } catch (e) { toast('Could not list printers: ' + e.message, true); }
}

// =====================================================================
//  WiFi add modal
// =====================================================================
function openWifi() { document.getElementById('wifiModal').hidden = false; document.getElementById('wifiMsg').textContent = ''; document.getElementById('wifiIp').focus(); }
function closeWifi() { document.getElementById('wifiModal').hidden = true; }
async function addWifi() {
  const ip = document.getElementById('wifiIp').value.trim();
  const name = document.getElementById('wifiName').value.trim();
  const msg = document.getElementById('wifiMsg');
  if (!ip) { msg.textContent = 'Enter an IP address.'; return; }
  msg.textContent = 'Adding…';
  try {
    const r = await fetch('/api/add-wifi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, name }) });
    const j = await r.json();
    if (j.ok) { msg.textContent = 'Added as ' + j.name; await loadPrinters(j.name); setTimeout(closeWifi, 700); }
    else msg.textContent = 'Failed: ' + (j.error || 'unknown');
  } catch (e) { msg.textContent = 'Error: ' + e.message; }
}

// =====================================================================
//  SETTINGS POPOVER (printer + lp options)
// =====================================================================
function bindSettings() {
  const panel = document.getElementById('settings');
  document.getElementById('settingsBtn').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) document.getElementById('lpOptsInput').value = lpOptionString();
  });
  const input = document.getElementById('lpOptsInput');
  input.addEventListener('input', () => {
    if (input.value.trim()) setLpOptionString(input.value);
    else localStorage.removeItem('lpopts_' + ORIENT);
  });
}

// =====================================================================
//  TOAST
// =====================================================================
let toastT;
function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, err ? 6000 : 3000);
}

// =====================================================================
//  SESSION PERSISTENCE (IndexedDB — survives reloads)
// =====================================================================
const DB_NAME = 'postcard', DB_STORE = 'kv', SESSION_KEY = 'session';
let saveTimer = null, restoring = false;

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction(DB_STORE, 'readwrite');
    t.objectStore(DB_STORE).put(v, k);
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
}
async function idbGet(k) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction(DB_STORE, 'readonly');
    const rq = t.objectStore(DB_STORE).get(k);
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
}

// Only serialisable fields — images are kept as their data-URL `src` and the
// <img> is rebuilt on restore; layers reference an asset by id.
function serializeState() {
  return {
    v: 1, orient: ORIENT, uid, selId,
    assets: assets.map(a => ({ id: a.id, src: a.src, name: a.name })),
    layers: layers.map(l => ({
      id: l.id, assetId: l.assetId, name: l.name,
      x: l.x, y: l.y, scale: l.scale, rot: l.rot, opacity: l.opacity, visible: l.visible,
      dither: { ...l.dither },
    })),
  };
}
function scheduleSave() {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 400);   // saves ~0.4s after activity stops
}
async function saveState() {
  if (restoring) return;
  try { await idbSet(SESSION_KEY, serializeState()); } catch (_) {}
}

async function restoreState() {
  restoring = true;
  let s = null;
  try { s = await idbGet(SESSION_KEY); } catch (_) {}
  try {
    if (s && s.assets && (s.assets.length || (s.layers && s.layers.length))) {
      if (s.orient && s.orient !== ORIENT) { ORIENT = s.orient; updateOrientBtn(); applyFormat(); }
      const loaded = await Promise.all(s.assets.map(a => new Promise(res => {
        const img = new Image();
        img.onload = () => res({ id: a.id, src: a.src, name: a.name, img });
        img.onerror = () => res(null);
        img.src = a.src;
      })));
      assets = loaded.filter(Boolean);
      const byId = Object.fromEntries(assets.map(a => [a.id, a]));
      layers = (s.layers || []).filter(l => byId[l.assetId]).map(l => ({
        ...l, src: byId[l.assetId].src, img: byId[l.assetId].img, _baked: null, _bakeKey: null,
      }));
      uid = Math.max(s.uid || 0, 0, ...assets.map(a => a.id), ...layers.map(l => l.id)) + 1;
      selId = (s.selId && layers.some(l => l.id === s.selId)) ? s.selId
            : (layers.length ? layers[layers.length - 1].id : null);
      renderThumbs(); syncBar(); render();
    }
  } finally {
    restoring = false;
  }
  saveState();   // persist the restored (or empty) state
}

// =====================================================================
//  WIRE UP
// =====================================================================
function init() {
  document.getElementById('addImageBtn').addEventListener('click', () => document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });

  document.getElementById('orientBtn').addEventListener('click', () => {
    ORIENT = ORIENT === 'landscape' ? 'portrait' : 'landscape';
    applyFormat(); updateOrientBtn();
  });

  document.getElementById('printBtn').addEventListener('click', onPrintClick);
  document.getElementById('exportBtn').addEventListener('click', exportPNG);

  // optional name/title field — remembered, but always visible & editable
  const ni = document.getElementById('nameInput');
  if (ni) {
    ni.value = localStorage.getItem('participant_name') || '';
    ni.addEventListener('input', () => localStorage.setItem('participant_name', ni.value.trim()));
  }
  document.getElementById('refreshPrinters').addEventListener('click', () => { toast('discovering printers…'); loadPrinters(); });
  document.getElementById('addWifiBtn').addEventListener('click', openWifi);
  document.getElementById('wifiCancel').addEventListener('click', closeWifi);
  document.getElementById('wifiAdd').addEventListener('click', addWifi);

  // drag & drop
  const stage = document.getElementById('stage');
  ['dragenter', 'dragover'].forEach(ev => stage.addEventListener(ev, e => { e.preventDefault(); stage.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => stage.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop') handleFiles(e.dataTransfer.files); stage.classList.remove('dragover'); }));

  // paste
  window.addEventListener('paste', e => {
    const items = e.clipboardData?.items || [];
    for (const it of items) if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) handleFiles([f]); }
  });

  window.addEventListener('resize', () => { fitCanvas(); render(); });

  bindBar();
  bindSettings();
  updateOrientBtn();
  applyFormat();
  fetchConfig();   // decides local (print) vs queue (send to print); loads printers when local
  syncBar();
  renderThumbs();
  restoreState();  // bring back the previous session (library + canvas) if any
}

init();
