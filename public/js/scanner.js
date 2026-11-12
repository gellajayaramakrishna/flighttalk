/*
 * FlightTalk boarding-pass scanner (browser only, fully offline).
 *
 * Pipeline:
 *   image -> canvas (EXIF-rotated, resized)
 *         -> 1) barcode decode (zxing-wasm: PDF417 / Aztec / QR / DataMatrix) -> IATA BCBP parse
 *         -> 2) if no barcode: contrast-boosted OCR (tesseract.js) -> text parse
 *
 * Every asset (wasm, worker, language data) is served by the local FlightTalk server.
 * The image itself is never uploaded.
 */
(function () {
  'use strict';

  const BARCODE_FORMATS = ['PDF417', 'Aztec', 'QRCode', 'DataMatrix'];
  let zxingReady = null;
  let ocrWorker = null;

  function ensureZXing() {
    if (zxingReady) return zxingReady;
    zxingReady = Promise.resolve().then(() => {
      if (!window.ZXingWASM) throw new Error('Barcode reader not loaded');
      window.ZXingWASM.prepareZXingModule({
        overrides: {
          locateFile: (path, prefix) => (path.endsWith('.wasm') ? `/vendor/zxing/${path}` : prefix + path)
        },
        fireImmediately: true
      });
      return window.ZXingWASM;
    });
    return zxingReady;
  }

  async function ensureOcr(onProgress) {
    if (ocrWorker) return ocrWorker;
    ocrWorker = window.Tesseract.createWorker('eng', 1, {
      workerPath: '/vendor/tesseract/dist/worker.min.js',
      corePath: '/vendor/tesseract-core',
      langPath: '/vendor/tessdata',
      gzip: true,
      workerBlobURL: false,
      logger: (m) => {
        if (onProgress && m.status === 'recognizing text') onProgress(`Reading text ${Math.round(m.progress * 100)}%`);
      }
    });
    return ocrWorker;
  }

  async function fileToCanvas(file, maxSide) {
    let source;
    try {
      source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      source = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not open that image'));
        img.src = URL.createObjectURL(file);
      });
    }
    const w = source.width;
    const h = source.height;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (source.close) source.close();
    return canvas;
  }

  /** Grayscale + percentile contrast stretch. Helps both the barcode reader and OCR on dim cabin photos. */
  function enhance(canvas, upscaleTo) {
    let src = canvas;
    if (upscaleTo && canvas.width < upscaleTo) {
      const f = upscaleTo / canvas.width;
      src = document.createElement('canvas');
      src.width = Math.round(canvas.width * f);
      src.height = Math.round(canvas.height * f);
      const c = src.getContext('2d');
      c.imageSmoothingQuality = 'high';
      c.drawImage(canvas, 0, 0, src.width, src.height);
    }
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, out.width, out.height);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      d[i] = g;
      hist[g] += 1;
    }
    const total = d.length / 4;
    let lo = 0;
    let hi = 255;
    for (let acc = 0; lo < 255 && (acc += hist[lo]) < total * 0.02; lo += 1);
    for (let acc = 0; hi > 0 && (acc += hist[hi]) < total * 0.02; hi -= 1);
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  function imageData(canvas) {
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  }

  async function decodeBarcode(canvas) {
    const Z = await ensureZXing();
    const results = await Z.readBarcodes(imageData(canvas), {
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
      tryDownscale: true,
      formats: BARCODE_FORMATS,
      maxNumberOfSymbols: 4
    });
    for (const r of results) {
      if (!r.isValid || !r.text) continue;
      const parsed = window.FTParse.parseBCBP(r.text);
      if (parsed) return Object.assign(parsed, { barcodeFormat: r.format });
    }
    return null;
  }

  async function scanFile(file, onProgress) {
    const progress = onProgress || (() => {});
    progress('Opening image…');
    const canvas = await fileToCanvas(file, 2400);

    progress('Looking for the boarding-pass barcode…');
    try {
      const found = (await decodeBarcode(canvas)) || (await decodeBarcode(enhance(canvas)));
      if (found) return found;
    } catch (err) {
      console.warn('Barcode decode failed', err);
    }

    progress('No barcode found — reading the printed text…');
    const worker = await ensureOcr(progress);
    const prepared = enhance(canvas, 1800);
    const { data } = await worker.recognize(prepared);
    let parsed = window.FTParse.parseOcrText(data.text);
    if (!parsed.name || !parsed.seat || !parsed.flight || parsed.confidence.seat < 0.6 || parsed.confidence.flight < 0.6) {
      // Second pass in "sparse text" mode: boarding passes are label/value grids, not paragraphs.
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      const second = window.FTParse.parseOcrText((await worker.recognize(prepared)).data.text);
      await worker.setParameters({ tessedit_pageseg_mode: '3' });
      parsed = mergeOcr(parsed, second);
    }
    return parsed;
  }

  function mergeOcr(a, b) {
    const out = Object.assign({}, a, { confidence: Object.assign({}, a.confidence) });
    for (const key of ['name', 'flight', 'seat']) {
      if ((b.confidence[key] || 0) > (a.confidence[key] || 0)) {
        out[key] = b[key];
        out.confidence[key] = b.confidence[key];
      }
    }
    out.from = a.from || b.from;
    out.to = a.to || b.to;
    return out;
  }

  /** Live camera scanning (barcode only; needs HTTPS on phones). */
  function startLiveScan(video, onFound, onError) {
    let stopped = false;
    let stream = null;
    const canvas = document.createElement('canvas');

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false
        });
        video.srcObject = stream;
        await video.play();
        await ensureZXing();
        while (!stopped) {
          if (video.videoWidth) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0);
            const found = await decodeBarcode(canvas).catch(() => null);
            if (found && !stopped) {
              stop();
              onFound(found);
              return;
            }
          }
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch (err) {
        stop();
        onError(err);
      }
    })();

    function stop() {
      stopped = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    return stop;
  }

  window.FTScanner = {
    scanFile,
    startLiveScan,
    canLiveScan: () => Boolean(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  };
}());
