// Scan the 2D barcode (GS1 DataMatrix) on a medication carton and pull out the NDC, lot and expiration date.
// Uses the browser's own barcode reader where it has one, else the bundled ZXing reader (vendor/zxing.min.js,
// added when the Docker image is built), else lets you paste or type what a scanner app read.

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

let zxingLoad = null;
const loadZXing = () => zxingLoad ||= new Promise(res => {
  if (window.ZXing) return res(window.ZXing);
  const s = document.createElement('script'); s.src = 'vendor/zxing.min.js';
  s.onload = () => res(window.ZXing || null); s.onerror = () => res(null);
  document.head.append(s);
});

export function scanDialog(onResult) {
  const dlg = document.createElement('dialog'); dlg.className = 'scan';
  const video = document.createElement('video'); video.setAttribute('playsinline', ''); video.muted = true;
  const msg = document.createElement('div'); msg.className = 'note'; msg.textContent = 'Starting the camera…';
  const manual = document.createElement('input'); manual.placeholder = 'Or paste the barcode text, e.g. (01)00312345678906(17)271231(10)AB123';
  const useBtn = document.createElement('button'); useBtn.type = 'button'; useBtn.textContent = 'Use text';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Cancel';
  const h2 = document.createElement('h2'); h2.textContent = 'Scan carton barcode';
  const row = document.createElement('div'); row.className = 'row'; row.append(manual, useBtn);
  const row2 = document.createElement('div'); row2.className = 'row actions'; const sp = document.createElement('div'); sp.className = 'grow'; row2.append(sp, close);
  dlg.append(h2, video, msg, row, row2); document.body.append(dlg); dlg.showModal();
  let stream = null, stopped = false, zreader = null;
  const stop = () => { stopped = true; try { zreader && zreader.reset(); } catch {} if (stream) stream.getTracks().forEach(t => t.stop()); dlg.close(); dlg.remove(); };
  const done = text => {
    const r = parseGS1(text);
    if (!r.lot && !r.expires && !r.ndc) { msg.textContent = 'Read a code, but it has no lot or expiration date in it. Try the square 2D code on the carton.'; return false; }
    stop(); onResult(r); return true;
  };
  close.onclick = stop; dlg.addEventListener('cancel', stop);
  useBtn.onclick = () => { if (!done(manual.value)) msg.textContent = 'Couldn\'t find a lot or expiration date in that text.'; };

  (async () => {
    const formats = ['data_matrix', 'qr_code', 'code_128'];
    if ('BarcodeDetector' in window) {
      try {
        const ok = (await BarcodeDetector.getSupportedFormats()).filter(f => formats.includes(f));
        if (ok.includes('data_matrix')) {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          video.srcObject = stream; await video.play();
          msg.textContent = 'Point the camera at the square 2D code on the carton.';
          const det = new BarcodeDetector({ formats: ok });
          const loop = async () => { if (stopped) return; try { const c = await det.detect(video); for (const x of c) if (done(x.rawValue)) return; } catch {} setTimeout(loop, 250); };
          return loop();
        }
      } catch (e) { if (e.name === 'NotAllowedError') { msg.textContent = 'Camera permission was refused. Type or paste the code instead.'; return; } }
    }
    const Z = await loadZXing();
    if (!Z || stopped) { if (!stopped) msg.textContent = 'This browser can\'t read 2D codes here. Type the lot and expiration date, or paste text from a scanner app.'; return; }
    try {
      const hints = new Map(); hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.CODE_128]); hints.set(Z.DecodeHintType.TRY_HARDER, true);
      zreader = new Z.BrowserMultiFormatReader(hints, 300);
      msg.textContent = 'Point the camera at the square 2D code on the carton.';
      await zreader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, (res) => { if (res && !stopped) done(res.getText()); });
    } catch (e) { msg.textContent = e && e.name === 'NotAllowedError' ? 'Camera permission was refused. Type or paste the code instead.' : 'Couldn\'t start the camera. Type or paste the code instead.'; }
  })();
}
