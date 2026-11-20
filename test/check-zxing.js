// Build-time check that the bundled ZXing file has everything public/js/scan.js uses, and can read a GS1 DataMatrix.
const Z = require(require('path').resolve(process.argv[2]));
const need = ['DataMatrixReader', 'DataMatrixWriter', 'RGBLuminanceSource', 'HybridBinarizer', 'GlobalHistogramBinarizer', 'BinaryBitmap', 'DecodeHintType', 'BarcodeFormat', 'EncodeHintType'];
const missing = need.filter(k => !Z[k]); if (missing.length) { console.error('missing', missing); process.exit(1); }
const text = '0100300245918015172801311' + '0DX4471';
const bm = new Z.DataMatrixWriter().encode(text, Z.BarcodeFormat.DATA_MATRIX, 0, 0, new Map());
const m = 4, n = bm.getWidth(), W = n * m + 40, lum = new Uint8ClampedArray(W * W).fill(230);
for (let y = 0; y < n * m; y++) for (let x = 0; x < n * m; x++) if (bm.get(Math.floor(x / m), Math.floor(y / m))) lum[(y + 20) * W + x + 20] = 30;
const hints = new Map(); hints.set(Z.DecodeHintType.TRY_HARDER, true);
const got = new Z.DataMatrixReader().decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(lum, W, W))), hints).getText();
if (got !== text) { console.error('decoded', JSON.stringify(got)); process.exit(1); }
console.log('ZXing check passed');
