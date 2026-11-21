// Scan the 2D barcode (GS1 DataMatrix) on a medication carton and pull out the NDC, lot and expiration date.
// Readers, in order: the browser's own BarcodeDetector (Android Chrome), else the bundled ZXing reader
// (vendor/zxing.min.js, added when the Docker image is built; this is the iPhone path), else typed/pasted text.
// Carton codes are small and dense, so live scanning asks for a high-resolution feed, zooms in (iPhone Pro
// cameras can't focus closer than ~20 cm without the Camera app's macro mode), and decodes an enlarged crop of
// the middle of the frame. "Take a photo" uses the phone's own camera app (macro, tap to focus) and decodes the still.

// GS1 Application Identifiers we care about, with fixed lengths where they have one
const FIXED = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
export function parseGS1(raw) {
  let t = String(raw || '').trim().replace(/^\]([dCQe])\d/, '');
  const out = {};
  if (t.includes('(')) { for (const m of t.matchAll(/\((\d{2,4})\)([^(]*)/g)) out[m[1]] = m[2].trim(); }
  else {
    const GS = '\x1d'; t = t.replace(/[\x1d␝]|<GS>|\{GS\}/gi, GS);
    let i = 0;
    while (i < t.length) {
      if (t[i] === GS) { i++; continue; }
      const ai = t.slice(i, i + 2);
      if (!/^\d\d$/.test(ai)) break;
      if (FIXED[ai]) { out[ai] = t.slice(i + 2, i + 2 + FIXED[ai]); i += 2 + FIXED[ai]; continue; }
      const ai3 = /^(24|25|71|72)/.test(ai) ? t.slice(i, i + 3) : ai; // a few 3-digit AIs (240, 241, 710…)
      const start = i + ai3.length, end = t.indexOf(GS, start);
      out[ai3] = t.slice(start, end < 0 ? t.length : end); i = end < 0 ? t.length : end + 1;
    }
  }
  const r = { raw: String(raw) };
  if (out['01']) {
    r.gtin = out['01'];
    // US drug GTIN-14: "003" + 10-digit NDC + check digit
    if (/^\d{14}$/.test(r.gtin) && r.gtin.slice(0, 3) === '003') r.ndc = r.gtin.slice(3, 13);
  }
  if (out['17'] && /^\d{6}$/.test(out['17'])) {
    const y = 2000 + +out['17'].slice(0, 2), m = +out['17'].slice(2, 4); let d = +out['17'].slice(4, 6);
    if (!d) d = new Date(y, m, 0).getDate(); // "00" day means the end of the month
    r.expires = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  if (out['10']) r.lot = out['10'];
  if (out['21']) r.serial = out['21'];
  return r;
}

// ---------- decoding with ZXing (pure functions; tests call these directly) ----------
// RGBA pixels -> luminance
export function luma(rgba) {
  const n = rgba.length >> 2, out = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return out;
}
export function makeReaders(Z) {
  const hints = new Map();
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.QR_CODE]);
  const readers = [new Z.DataMatrixReader()];
  if (Z.QRCodeReader) readers.push(new Z.QRCodeReader());
  return { hints, readers };
}
// Image clean-ups for real cartons: many print the code light-on-dark (inverted), and inkjet printers make each
// square a separate round dot, which breaks the solid edges the reader looks for. Shrinking, stretching the
// contrast and a 1-pixel "min" filter merge the dots back into solid squares.
export function shrink(lum, w, h, k) {
  const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k)), o = new Uint8ClampedArray(dw * dh);
  for (let y = 0; y < dh; y++) { const y0 = Math.floor(y / k), y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) / k)));
    for (let x = 0; x < dw; x++) { const x0 = Math.floor(x / k), x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) / k))); let t = 0;
      for (let Y = y0; Y < y1; Y++) for (let X = x0; X < x1; X++) t += lum[Y * w + X]; o[y * dw + x] = t / ((y1 - y0) * (x1 - x0)); } }
  return [o, dw, dh];
}
export const invert = lum => lum.map(v => 255 - v);
export function stretch(lum) {
  const hist = new Uint32Array(256); for (const v of lum) hist[v]++;
  let lo = 0, hi = 255, acc = 0; const cut = lum.length * 0.02;
  for (; lo < 255 && (acc += hist[lo]) < cut; lo++); acc = 0; for (; hi > 0 && (acc += hist[hi]) < cut; hi--);
  const k = 255 / Math.max(1, hi - lo); return lum.map(v => (v - lo) * k);
}
export function merge(lum, w, h) { // 3x3 min filter: grows dark dots so neighbors touch
  const t = new Uint8ClampedArray(lum.length), o = new Uint8ClampedArray(lum.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; t[i] = Math.min(lum[i], x > 0 ? lum[i - 1] : 255, x < w - 1 ? lum[i + 1] : 255); }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; o[i] = Math.min(t[i], y > 0 ? t[i - w] : 255, y < h - 1 ? t[i + w] : 255); }
  return o;
}
// every way we try a window, most likely first
export function decodeAny(Z, R, lum, w, h) {
  for (const k of [1, 0.5, 0.33, 0.25]) {
    const [s, sw, sh] = k === 1 ? [lum, w, h] : shrink(lum, w, h, k);
    if (sw < 60) break;
    const tries = k === 1 ? [() => s, () => invert(s), () => merge(stretch(invert(s)), sw, sh), () => merge(stretch(s), sw, sh)]
      : [() => merge(stretch(invert(s)), sw, sh), () => merge(stretch(s), sw, sh), () => stretch(invert(s)), () => stretch(s)];
    for (const t of tries) { const r = decodeLuma(Z, R, t(), sw, sh); if (r) return r; }
  }
  return null;
}

// try each reader on a luminance image; returns the text or null
export function decodeLuma(Z, R, lum, w, h) {
  for (const bin of [Z.HybridBinarizer, Z.GlobalHistogramBinarizer]) {
    const bmp = new Z.BinaryBitmap(new bin(new Z.RGBLuminanceSource(lum, w, h)));
    for (const rd of R.readers) { try { return rd.decode(bmp, R.hints).getText(); } catch (e) { /* not found here */ } finally { try { rd.reset(); } catch (e) {} } }
  }
  return null;
}
// ZXing only finds a DataMatrix near the middle of the image it's given, so we first look for spots that
// look like a 2D code (a dense, high-contrast square with a quieter border) and decode a window centered on each.
export function findSpots(lum, w, h, max = 30) {
  const c = Math.max(2, Math.round(Math.min(w, h) / 80)), gw = Math.floor(w / c), gh = Math.floor(h / c);
  const e = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let s = 0, x0 = gx * c, y0 = gy * c;
    for (let y = y0; y < y0 + c && y < h - 1; y++) for (let x = x0; x < x0 + c && x < w - 1; x++) { const i = y * w + x, v = lum[i]; s += Math.abs(v - lum[i + 1]) + Math.abs(v - lum[i + w]); }
    e[gy * gw + gx] = s / (c * c);
  }
  // integral image for fast box sums
  const I = new Float64Array((gw + 1) * (gh + 1));
  for (let y = 0; y < gh; y++) { let row = 0; for (let x = 0; x < gw; x++) { row += e[y * gw + x]; I[(y + 1) * (gw + 1) + x + 1] = I[y * (gw + 1) + x + 1] + row; } }
  const box = (x0, y0, x1, y1) => I[y1 * (gw + 1) + x1] - I[y0 * (gw + 1) + x1] - I[y1 * (gw + 1) + x0] + I[y0 * (gw + 1) + x0];
  const out = [];
  for (const r of [2, 4, 7]) {           // half-size of the square in cells
    const k = 2 * r + 1, sc = [];
    for (let y = r; y < gh - r; y++) for (let x = r; x < gw - r; x++) {
      const inner = box(x - r, y - r, x + r + 1, y + r + 1) / (k * k);
      // a code is a dense square with a quieter border around it
      const R2 = Math.round(r * 1.6), x0 = Math.max(0, x - R2), y0 = Math.max(0, y - R2), x1 = Math.min(gw, x + R2 + 1), y1 = Math.min(gh, y + R2 + 1);
      const ring = (box(x0, y0, x1, y1) - inner * k * k) / Math.max(1, (x1 - x0) * (y1 - y0) - k * k);
      sc.push([inner - 0.6 * ring, x, y]);
    }
    sc.sort((a, b) => b[0] - a[0]);
    const taken = [];
    for (const [s, x, y] of sc) {
      if (taken.length >= max / 3) break;
      if (taken.some(t => Math.abs(t[0] - x) <= r && Math.abs(t[1] - y) <= r)) continue;
      taken.push([x, y]); out.push({ score: s, cx: (x + 0.5) * c, cy: (y + 0.5) * c, size: k * c });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// draw part of an image/video into the canvas at dw x dh (the browser scales it smoothly) and return its luminance
function grab(canvas, src, sx, sy, sw, sh, dw, dh) {
  canvas.width = dw; canvas.height = dh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, dw, dh);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
  return luma(ctx.getImageData(0, 0, dw, dh).data);
}
// windows to try on a w x h picture: the middle first (where the guide box is), then the code-like spots
function* windows(canvas, src, w, h, { maxSpots, overview, outMin, outMax, center = true }) {
  const m = Math.min(w, h);
  if (center) for (const c of [0.6, 0.45, 0.3]) { const sd = m * c; yield [(w - sd) / 2, (h - sd) / 2, sd, Math.min(outMax, Math.max(outMin, Math.round(sd)))]; }
  const k = Math.min(1, overview / Math.max(w, h)), dw = Math.round(w * k), dh = Math.round(h * k);
  const small = grab(canvas, src, 0, 0, w, h, dw, dh);
  for (const sp of findSpots(small, dw, dh).slice(0, maxSpots)) for (const sd of [sp.size / k * 2.2, sp.size / k * 3.5, Math.max(sp.size / k * 5, m * 0.5)]) {
    yield [sp.cx / k - sd / 2, sp.cy / k - sd / 2, sd, Math.min(outMax, Math.max(outMin, Math.round(sd * 1.5)))];
  }
}
function decodeWin(Z, R, canvas, src, [sx, sy, sd, out]) { return decodeAny(Z, R, grab(canvas, src, sx, sy, sd, sd, out, out), out, out); }

let zxingLoad = null;
const loadZXing = () => zxingLoad ||= new Promise(res => {
  if (window.ZXing) return res(window.ZXing);
  const s = document.createElement('script'); s.src = 'vendor/zxing.min.js';
  s.onload = () => res(window.ZXing || null); s.onerror = () => res(null);
  document.head.append(s);
});
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); kids.forEach(k => e.append(k)); return e; };

export function scanDialog(onResult) {
  const dlg = el('dialog', { className: 'scan' });
  const video = el('video', { muted: true, autoplay: true }); video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
  const guide = el('div', { className: 'guide' }), view = el('div', { className: 'scanview' }, video, guide);
  const msg = el('div', { className: 'note', textContent: 'Starting the camera…' });
  const zoomRow = el('div', { className: 'row zoomrow hide' });
  const photoIn = el('input', { type: 'file', accept: 'image/*', className: 'hide' }); photoIn.setAttribute('capture', 'environment');
  const photoBtn = el('button', { type: 'button', textContent: 'Take a photo instead', className: 'photobtn' });
  const manual = el('input', { placeholder: 'Or paste the barcode text, e.g. (01)00312345678906(17)271231(10)AB123' });
  const useBtn = el('button', { type: 'button', textContent: 'Use text' });
  const close = el('button', { type: 'button', textContent: 'Cancel' });
  dlg.append(el('h2', { textContent: 'Scan carton barcode' }), view, msg, zoomRow, photoBtn, photoIn,
    el('div', { className: 'row' }, manual, useBtn), el('div', { className: 'row actions' }, el('div', { className: 'grow' }), close));
  document.body.append(dlg); dlg.showModal();
  let stream = null, stopped = false, timer = null;
  const stop = () => { stopped = true; clearTimeout(timer); if (stream) stream.getTracks().forEach(t => t.stop()); dlg.close(); dlg.remove(); };
  const done = text => {
    const r = parseGS1(text);
    if (!r.lot && !r.expires && !r.ndc) { msg.textContent = 'Read a code, but it has no lot or expiration date in it. Aim at the small square 2D code.'; return false; }
    if (navigator.vibrate) navigator.vibrate(60);
    stop(); onResult(r); return true;
  };
  close.onclick = stop; dlg.addEventListener('cancel', stop);
  useBtn.onclick = () => { if (!done(manual.value)) msg.textContent = 'Couldn\'t find a lot or expiration date in that text.'; };
  const canvas = document.createElement('canvas');
  loadZXing(); // start fetching the reader now

  // keep the guide square over the middle of the picture (the part we decode first)
  const placeGuide = () => {
    const vw = video.videoWidth, vh = video.videoHeight, bw = view.clientWidth, bh = view.clientHeight; if (!vw || !bw) return;
    const k = Math.min(bw / vw, bh / vh), dw = vw * k, dh = vh * k, s = Math.min(dw, dh) * 0.45;
    Object.assign(guide.style, { width: s + 'px', height: s + 'px', left: (bw - s) / 2 + 'px', top: (bh - s) / 2 + 'px' });
  };
  video.addEventListener('loadedmetadata', placeGuide); video.addEventListener('resize', placeGuide); window.addEventListener('resize', placeGuide);

  // ----- take a photo with the phone's camera app, then decode the still -----
  photoBtn.onclick = () => photoIn.click();
  photoIn.onchange = async () => {
    const f = photoIn.files[0]; if (!f) return;
    msg.textContent = 'Reading the photo…';
    const Z = await loadZXing(); if (!Z) { msg.textContent = 'The barcode reader isn\'t available. Type the lot and expiration date instead.'; return; }
    let img; try { img = await createImageBitmap(f); } catch { img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(f); }); }
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight, R = makeReaders(Z);
    for (const win of windows(canvas, img, w, h, { maxSpots: 30, overview: 900, outMin: 300, outMax: 700 })) {
      if (stopped) return;
      const t = decodeWin(Z, R, canvas, img, win);
      if (t && done(t)) return;
      await new Promise(r => setTimeout(r, 0)); // keep the page responsive between tries
    }
    msg.textContent = 'Couldn\'t find the code in that photo. Try again closer, with the square code sharp and filling more of the picture.';
    photoIn.value = '';
  };

  // ----- live camera -----
  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    } catch (e) {
      msg.textContent = e && e.name === 'NotAllowedError' ? 'Camera permission was refused. Use "Take a photo instead" or type the code.' : 'Couldn\'t start the camera. Use "Take a photo instead" or type the code.';
      view.classList.add('hide'); return;
    }
    if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
    video.srcObject = stream; try { await video.play(); } catch {}
    const track = stream.getVideoTracks()[0], caps = track.getCapabilities ? track.getCapabilities() : {};
    try { if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}
    if (caps.zoom && caps.zoom.max > 1) {
      const levels = [1, 2, 3].filter(z => z >= caps.zoom.min && z <= caps.zoom.max);
      const setZoom = async z => { try { await track.applyConstraints({ advanced: [{ zoom: z }] }); } catch {} zoomRow.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.z === z)); };
      levels.forEach(z => { const b = el('button', { type: 'button', className: 'sm', textContent: z + '×' }); b.dataset.z = z; b.onclick = () => setZoom(z); zoomRow.append(b); });
      zoomRow.classList.remove('hide');
      await setZoom(levels.includes(2) ? 2 : levels[levels.length - 1]);
    }
    msg.textContent = 'Point at the small square code, about 15–20 cm (6–8 in) away; the box is the best spot. If it looks blurry, move back a little or use "Take a photo instead".';

    // Android Chrome: the browser's own reader
    if ('BarcodeDetector' in window) {
      try {
        const ok = (await BarcodeDetector.getSupportedFormats()).filter(f => ['data_matrix', 'qr_code'].includes(f));
        if (ok.includes('data_matrix')) {
          const det = new BarcodeDetector({ formats: ok });
          const loop = async () => { if (stopped) return; try { for (const c of await det.detect(video)) if (done(c.rawValue)) return; } catch {} timer = setTimeout(loop, 200); };
          return loop();
        }
      } catch {}
    }
    // iPhone and others: ZXing on enlarged crops of the frame, one region per pass
    const Z = await loadZXing();
    if (!Z) { msg.textContent = 'This browser can\'t read 2D codes here. Use "Take a photo instead" or type the lot and expiration date.'; return; }
    const R = makeReaders(Z); let cursor = 0;
    const loop = () => {
      if (stopped) return;
      if (video.readyState >= 2 && video.videoWidth) {
        // each pass gets ~400 ms; the next pass carries on from the next window, so every spot gets its turn
        const wins = [...windows(canvas, video, video.videoWidth, video.videoHeight, { maxSpots: 6, overview: 640, outMin: 320, outMax: 640 })];
        const t0 = performance.now();
        for (let j = 0; j < wins.length; j++) {
          const win = wins[(cursor + j) % wins.length];
          const t = decodeWin(Z, R, canvas, video, win);
          if (t && done(t)) return;
          if (performance.now() - t0 > 400) { cursor = (cursor + j + 1) % wins.length; break; }
        }
      }
      timer = setTimeout(loop, 60);
    };
    loop();
  })();
}
