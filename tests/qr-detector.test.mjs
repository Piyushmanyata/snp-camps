/**
 * Capability gate and jsQR decode helper for #49.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseNativeQrDetector,
  decodeQrFromImageData,
  getBarcodeDetectorConstructor,
} from "../src/lib/qr-detector.ts";

test("canUseNativeQrDetector is false without BarcodeDetector", async () => {
  const prev = globalThis.BarcodeDetector;
  // @ts-expect-error test cleanup
  delete globalThis.BarcodeDetector;
  assert.equal(await canUseNativeQrDetector(), false);
  assert.equal(getBarcodeDetectorConstructor(), null);
  if (prev) globalThis.BarcodeDetector = prev;
});

test("canUseNativeQrDetector requires getSupportedFormats to list qr_code", async () => {
  const prev = globalThis.BarcodeDetector;
  globalThis.BarcodeDetector = class {
    static async getSupportedFormats() {
      return ["code_128"];
    }
    detect() {
      return Promise.resolve([]);
    }
  };
  assert.equal(await canUseNativeQrDetector(), false);

  globalThis.BarcodeDetector = class {
    static async getSupportedFormats() {
      return ["qr_code", "code_128"];
    }
    detect() {
      return Promise.resolve([]);
    }
  };
  assert.equal(await canUseNativeQrDetector(), true);
  if (prev) globalThis.BarcodeDetector = prev;
  else delete globalThis.BarcodeDetector;
});

test("decodeQrFromImageData returns null when decoder finds nothing", () => {
  const imageData = {
    data: new Uint8ClampedArray(4),
    width: 1,
    height: 1,
  };
  assert.equal(
    decodeQrFromImageData(() => null, /** @type {ImageData} */ (imageData)),
    null,
  );
  assert.equal(
    decodeQrFromImageData(
      () => ({ data: "snp:abc" }),
      /** @type {ImageData} */ (imageData),
    ),
    "snp:abc",
  );
});
