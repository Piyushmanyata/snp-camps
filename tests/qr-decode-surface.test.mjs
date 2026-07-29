/**
 * Empirical guard for the Aadhaar live decode loop (#72 selection contract).
 *
 * Two regressions have shipped here, both invisible to the existing unit tests
 * because those tests feed the parser a payload string and never build a frame:
 *
 *  1. The live loop decoded each probe crop at native camera resolution. One
 *     thorough whole-frame probe then cost ~13s on a desktop CPU, so the
 *     scanner appeared frozen. Legacy cards took the whole hit; modern Secure
 *     QR cards did not, because the platform detector reads those off the raw
 *     video before any probe runs.
 *  2. A tiny legacy QR (physically far smaller than a modern Secure QR) has to
 *     survive the crop-and-magnify path to be readable at all.
 *
 * So this asserts the *surface bound* and the *read* on real rendered QR
 * frames, not on source text.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join, sep } from "node:path";

import {
  AADHAAR_PROBES,
  MAX_DECODE_EDGE,
  decodeImageMultiPass,
  probeSurface,
  loadZbar,
  loadZxing,
  setDecoderWasmBase,
  FAST_VARIANTS,
  THOROUGH_VARIANTS,
} from "@/lib/qr-decode-pipeline";
import { parseAadhaarQrAsync } from "@/lib/aadhaar-qr";

if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height ?? data.length / 4 / width;
    }
  };
}

// @zxing/library is the *writer* here — it renders the QR fixtures. The
// decoders under test are the two WASM engines the app actually ships.
const zxing = await import("@zxing/library");

// Point the engines at the local binaries copied by scripts/copy-wasm.mjs.
// Emscripten resolves locateFile against a URL, which has no meaning here, so
// ZXing gets its binary directly while ZBar takes a filesystem path.
const wasmDir = join(process.cwd(), "public", "wasm");
const zxingWasm = readFileSync(join(wasmDir, "zxing_reader.wasm"));
setDecoderWasmBase(`${wasmDir}${sep}`, {
  zxingWasmBinary: zxingWasm.buffer.slice(
    zxingWasm.byteOffset,
    zxingWasm.byteOffset + zxingWasm.byteLength,
  ),
});

const [zxingReader, zbarReader] = await Promise.all([loadZxing(), loadZbar()]);
assert.ok(zxingReader, "zxing-wasm failed to load — run `npm run wasm:copy`");
assert.ok(zbarReader, "zbar-wasm failed to load — run `npm run wasm:copy`");

const LEGACY_XML =
  '<PrintLetterBarcodeData uid="324779287260" name="Jyothsna Mondal" ' +
  'gender="F" yob="1990" gname="Madhab Pandit" vtc="Uttar Bhag" ' +
  'po="Brindakhali" dist="South 24 Parganas" subdist="Baruipur" ' +
  'state="West Bengal" pc="743387" dob="01/01/1990"/>';

/** Old physical Aadhaar cards carry the XML bytes as one huge decimal integer. */
function legacyNumericPayload(text) {
  let big = 0n;
  for (let i = 0; i < text.length; i++) big = (big << 8n) | BigInt(text.charCodeAt(i) & 0xff);
  return big.toString(10);
}

/** Render `text` as a QR at `pxPerModule`, as ink-on-paper greys. */
function renderQr(text, pxPerModule) {
  const hints = new Map();
  hints.set(zxing.EncodeHintType.MARGIN, 4);
  hints.set(zxing.EncodeHintType.CHARACTER_SET, "ISO-8859-1");
  const matrix = new zxing.MultiFormatWriter().encode(
    text,
    zxing.BarcodeFormat.QR_CODE,
    1,
    1,
    hints,
  );
  const modules = matrix.getWidth();
  const size = modules * pxPerModule;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = matrix.get(Math.floor(x / pxPerModule), Math.floor(y / pxPerModule)) ? 30 : 225;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { image: new globalThis.ImageData(data, size, size), modules };
}

/** Paste a rendered QR into the centre of a `width`x`height` camera frame. */
function frameWith(qr, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const j = i * 4;
    data[j] = data[j + 1] = data[j + 2] = 205;
    data[j + 3] = 255;
  }
  const ox = Math.floor((width - qr.image.width) / 2);
  const oy = Math.floor((height - qr.image.height) / 2);
  for (let y = 0; y < qr.image.height; y++) {
    for (let x = 0; x < qr.image.width; x++) {
      const source = (y * qr.image.width + x) * 4;
      const dest = ((oy + y) * width + ox + x) * 4;
      data[dest] = data[dest + 1] = data[dest + 2] = qr.image.data[source];
      data[dest + 3] = 255;
    }
  }
  return new globalThis.ImageData(data, width, height);
}

/** Nearest-neighbour resample of a source rect — stands in for drawImage. */
function resample(frame, sx, sy, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const srcX = Math.min(frame.width - 1, sx + Math.floor(x * xRatio));
      const srcY = Math.min(frame.height - 1, sy + Math.floor(y * yRatio));
      const s = (srcY * frame.width + srcX) * 4;
      const d = (y * dw + x) * 4;
      out[d] = frame.data[s];
      out[d + 1] = frame.data[s + 1];
      out[d + 2] = frame.data[s + 2];
      out[d + 3] = 255;
    }
  }
  return new globalThis.ImageData(out, dw, dh);
}

/** Run the probe sweep the way the live loop does, returning the first payload. */
async function sweep(frame, { thorough = false } = {}) {
  const options = {
    zxing: zxingReader,
    zbar: zbarReader,
    variants: thorough ? THOROUGH_VARIANTS : FAST_VARIANTS,
  };
  for (const probe of AADHAAR_PROBES) {
    const surface = probeSurface(frame.width, frame.height, probe);
    if (!surface) continue;
    const { sx, sy, cw, ch, dw, dh } = surface;
    const hit = await decodeImageMultiPass(
      resample(frame, sx, sy, cw, ch, dw, dh),
      options,
    );
    if (hit) return hit;
  }
  return null;
}

test("every live probe surface stays within MAX_DECODE_EDGE", () => {
  // 2560x1440 is what the scanner asks getUserMedia for.
  for (const probe of AADHAAR_PROBES) {
    const surface = probeSurface(2560, 1440, probe);
    assert.ok(surface, `probe ${JSON.stringify(probe)} produced no surface`);
    const longest = Math.max(surface.dw, surface.dh);
    assert.ok(
      longest <= MAX_DECODE_EDGE,
      `probe ${JSON.stringify(probe)} decodes a ${surface.dw}x${surface.dh} surface, ` +
        `over the ${MAX_DECODE_EDGE}px cap — a thorough pass at that size costs seconds per frame`,
    );
  }
});

test("probe surface stays inside the frame and magnifies the tight probes", () => {
  for (const probe of AADHAAR_PROBES) {
    const { sx, sy, cw, ch, dw } = probeSurface(2560, 1440, probe);
    assert.ok(sx >= 0 && sx + cw <= 2560, `probe ${JSON.stringify(probe)} crops outside the frame`);
    assert.ok(sy >= 0 && sy + ch <= 1440, `probe ${JSON.stringify(probe)} crops outside the frame`);
    // A zoomed probe must end up with more pixels per module than its crop had.
    if (probe.zoom > 1) assert.ok(dw > cw, `zoom probe ${JSON.stringify(probe)} did not magnify`);
  }
});

test("tiny legacy XML card decodes and parses through the live probe sweep", async () => {
  // 3px/module in a 2560-wide frame: the QR spans ~8% of the frame, which is
  // what an old card's physically small QR actually looks like at desk distance.
  const qr = renderQr(legacyNumericPayload(LEGACY_XML), 3);
  const payload = await sweep(frameWith(qr, 2560, 1440));
  assert.ok(payload, "no probe geometry read the tiny legacy QR");

  const parsed = await parseAadhaarQrAsync(payload);
  assert.equal(parsed.fullName, "Jyothsna Mondal");
  assert.equal(parsed.gender, "F");
  assert.equal(parsed.dateOfBirth, "1990-01-01");
  assert.equal(parsed.aadhaarLast4, "7260");
  assert.equal(parsed.source, "legacy_xml");
});

test("dense modern Secure QR still reads at MAX_DECODE_EDGE", async () => {
  // High-entropy payload of the size a real Secure QR carries — this is the
  // floor that stops MAX_DECODE_EDGE being tuned down for the legacy case.
  const dense = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(32 + ((i * 61) % 95))).join("");
  const qr = renderQr(dense, 6);
  assert.ok(qr.modules >= 100, `expected a dense code, got ${qr.modules} modules`);
  assert.ok(
    await sweep(frameWith(qr, 2560, 1440)),
    `dense ${qr.modules}-module Secure QR no longer reads at MAX_DECODE_EDGE=${MAX_DECODE_EDGE}`,
  );
});
