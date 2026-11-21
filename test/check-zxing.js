// Build-time check: the bundled ZXing file has what public/js/scan.js uses, and scan.js's pipeline reads
// both a plain GS1 DataMatrix and a light-on-dark, dotted (inkjet) one like real medication cartons.
const fs = require('fs'), path = require('path');
const Z = require(path.resolve(process.argv[2]));
const need = ['DataMatrixReader', 'DataMatrixWriter', 'RGBLuminanceSource', 'HybridBinarizer', 'GlobalHistogramBinarizer', 'BinaryBitmap', 'DecodeHintType', 'BarcodeFormat'];
const missing = need.filter(k => !Z[k]); if (missing.length) { console.error('missing', missing); process.exit(1); }
const scanFile = process.argv[3] || path.join(__dirname, '../public/js/scan.js');
const src = fs.readFileSync(scanFile, 'utf8').replace(/export /g, '') + ';module.exports={decodeAny,makeReaders,parseGS1};';
const m = { exports: {} }; new Function('module', 'window', 'document', 'navigator', 'performance', src)(m, {}, {}, {}, {});
const S = m.exports, R = S.makeReaders(Z);
const text = '0100300245918015' + '17280131' + '10DX4471' + '\x1d' + '21SN842739';
const bm = new Z.DataMatrixWriter().encode(text, Z.BarcodeFormat.DATA_MATRIX, 0, 0, new Map()), n = bm.getWidth();
function draw(mod, dot, inverse) {
  const s = n * mod, W = s + 8 * mod, f = new Float32Array(W * W).fill(inverse ? 30 : 225), o0 = 4 * mod, r = dot * mod / 2;
  for (let my = 0; my < n; my++) for (let mx = 0; mx < n; mx++) if (bm.get(mx, my)) {
    const cx = o0 + (mx + .5) * mod, cy = o0 + (my + .5) * mod;
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) { const d = Math.hypot(x + .5 - cx, y + .5 - cy); if (d < r + .5) { const a = Math.min(1, r + .5 - d); f[y * W + x] = f[y * W + x] * (1 - a) + (inverse ? 190 : 40) * a; } }
  }
  return [new Uint8ClampedArray(f), W];
}
for (const [mod, dot, inverse, label] of [[6, 1, false, 'plain'], [10, 0.6, true, 'light-on-dark dotted'], [8, 0.7, false, 'dotted']]) {
  const [lum, W] = draw(mod, dot, inverse), got = S.decodeAny(Z, R, lum, W, W);
  if (got !== text || S.parseGS1(got).lot !== 'DX4471') { console.error('could not read the', label, 'code:', JSON.stringify(got)); process.exit(1); }
}
console.log('ZXing check passed');
