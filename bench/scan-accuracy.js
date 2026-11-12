#!/usr/bin/env node
/*
 * Boarding-pass extraction benchmark.
 *
 *   python3 bench/make_passes.py --count 60 --out bench/passes                 # barcode + text
 *   python3 bench/make_passes.py --count 60 --out bench/passes_text --text-only # text only
 *   node bench/scan-accuracy.js bench/passes [bench/passes_text]
 *
 * For every image it runs, fully offline:
 *   - zxing-wasm barcode decode  -> FlightTalk BCBP parser
 *   - tesseract.js OCR           -> FlightTalk OCR parser  vs  the original v1 regex
 * and reports per-field accuracy against labels.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const { prepareZXingModule, readBarcodes } = require('zxing-wasm/reader');
const P = require('../public/js/pass-parse');

const ROOT = path.join(__dirname, '..');
prepareZXingModule({
  overrides: { wasmBinary: fs.readFileSync(path.join(ROOT, 'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm')).buffer }
});

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');

function score(label, out) {
  const nameOk = Boolean(out.name) && P.identityKey(out.name) === P.identityKey({ surname: label.surname, given: label.given });
  return { flight: out.flight === label.flight, seat: out.seat === label.seat, name: nameOk };
}

async function run(dir, worker) {
  const labels = JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf8'));
  const rows = [];
  for (const label of labels) {
    const file = path.join(dir, label.file);
    const bytes = new Uint8Array(fs.readFileSync(file));

    let t = Date.now();
    let barcode = null;
    if (label.code !== 'none') {
      const found = await readBarcodes(bytes, { tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, formats: ['PDF417', 'Aztec', 'QRCode', 'DataMatrix'] });
      for (const r of found) {
        const parsed = r.isValid && P.parseBCBP(r.text);
        if (parsed) { barcode = parsed; break; }
      }
    }
    const barcodeMs = Date.now() - t;

    t = Date.now();
    await worker.setParameters({ tessedit_pageseg_mode: '3' });
    const text1 = (await worker.recognize(file)).data.text;
    let ocr = P.parseOcrText(text1);
    let text2 = '';
    if (!ocr.name || !ocr.flight || !ocr.seat || ocr.confidence.seat < 0.6 || ocr.confidence.flight < 0.6) {
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      text2 = (await worker.recognize(file)).data.text;
      const b = P.parseOcrText(text2);
      for (const k of ['name', 'flight', 'seat']) if ((b.confidence[k] || 0) > (ocr.confidence[k] || 0)) { ocr[k] = b[k]; ocr.confidence[k] = b.confidence[k]; }
    }
    const ocrMs = Date.now() - t;
    const legacy = P.legacyOcrParse(text1); // v1 only ran one OCR pass

    const pipeline = barcode || ocr; // what the app actually uses
    rows.push({
      file: label.file, quality: label.quality, code: label.code,
      barcode: barcode ? score(label, barcode) : null,
      ocr: score(label, ocr),
      legacy: score(label, legacy),
      pipeline: score(label, pipeline),
      source: barcode ? 'barcode' : 'ocr',
      barcodeMs, ocrMs
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return rows;
}

function pct(n, d) { return d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a'; }

function summarize(title, rows) {
  const fields = ['flight', 'seat', 'name'];
  const line = (label, key, filter = () => true) => {
    const rs = rows.filter((r) => r[key] && filter(r));
    const cells = fields.map((f) => pct(rs.filter((r) => r[key][f]).length, rs.length));
    const all = pct(rs.filter((r) => fields.every((f) => r[key][f])).length, rs.length);
    return `  ${label.padEnd(34)} ${cells.map((c) => c.padStart(8)).join('')} ${all.padStart(10)}   (n=${rs.length})`;
  };
  console.log(`\n${title}`);
  console.log(`  ${''.padEnd(34)} ${fields.map((f) => f.padStart(8)).join('')} ${'all three'.padStart(10)}`);
  console.log(line('v1 regex on OCR text (before)', 'legacy'));
  console.log(line('v2 OCR parser (after)', 'ocr'));
  if (rows.some((r) => r.barcode)) console.log(line('v2 barcode decode + BCBP (after)', 'barcode'));
  console.log(line('v2 full pipeline (barcode → OCR)', 'pipeline'));
  for (const q of ['clean', 'photo', 'poor']) console.log(line(`   … ${q} images`, 'pipeline', (r) => r.quality === q));
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };
  const bc = rows.filter((r) => r.code !== 'none').map((r) => r.barcodeMs);
  if (bc.length) console.log(`  median barcode decode: ${med(bc)} ms   median OCR: ${med(rows.map((r) => r.ocrMs))} ms`);
  else console.log(`  median OCR: ${med(rows.map((r) => r.ocrMs))} ms`);
  return rows;
}

(async () => {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error('usage: node bench/scan-accuracy.js <passes-dir> [more-dirs]');
    process.exit(1);
  }
  const worker = await Tesseract.createWorker('eng', 1, { langPath: path.join(ROOT, 'public/vendor/tessdata'), gzip: true, cachePath: path.join(ROOT, 'data', '.tess-cache') });
  const report = {};
  for (const dir of dirs) {
    const rows = await run(dir, worker);
    summarize(`== ${dir} ==`, rows);
    report[dir] = rows;
  }
  await worker.terminate();
  fs.mkdirSync(path.join(ROOT, 'bench', 'results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'bench', 'results', 'scan-accuracy.json'), JSON.stringify(report, null, 1));
})();
