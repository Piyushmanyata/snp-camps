/**
 * Multi-pass QR decoding for real-world Aadhaar cards, including photocopies.
 *
 * Why this exists: jsQR alone binarises with a simple threshold and gives up on
 * the first failure. A photocopied Aadhaar card is the worst case for that —
 * low contrast, grey background, halftone noise, and a very dense Secure QR
 * (up to 177x177 modules). The fix is not a better single call; it is trying
 * the same frame several ways:
 *
 *   1. Preprocess the image (contrast stretch, Otsu, adaptive threshold) so a
 *      faded or unevenly lit copy becomes clean black-and-white.
 *   2. Decode with ZXing (HybridBinarizer + TRY_HARDER, strongest on damaged
 *      and dense codes) and with jsQR, since each reads codes the other misses.
 *
 * Payloads are returned as bytes whenever possible: Aadhaar Secure QR is
 * byte-mode binary, and any string form is a lossy decode of those bytes.
 */

import type { JsQrFn, JsQrOptions } from "@/lib/qr-detector";

export type QrPayload = string | Uint8Array;

/** Preprocessing applied before a decode attempt. */
export type Variant = "raw" | "stretch" | "otsu" | "adaptive" | "invert";

/** Cheap enough to run on every live camera frame. */
export const FAST_VARIANTS: Variant[] = ["raw"];
/**
 * Escalation for a frame that will not read, and for uploaded photos.
 *
 * Every variant costs about the same (measured ~40-65ms per decode at 1280x720),
 * so the list length *is* the cost: each entry adds a full grayscale pass plus a
 * ZXing and a jsQR attempt. `invert` is omitted deliberately — an Aadhaar QR is
 * never printed inverted, which is also why the live jsQR options pass
 * `inversionAttempts: "dontInvert"`.
 */
export const THOROUGH_VARIANTS: Variant[] = [
  "raw",
  "stretch",
  "otsu",
  "adaptive",
];

/**
 * Longest edge, in pixels, worth handing a decoder.
 *
 * Decode cost is linear in pixel count, so bounding the surface is the single
 * biggest win available (measured at 2560x1440 vs 1280x720: 180ms vs 39ms for
 * one cheap pass, 1222ms vs 288ms for the full cascade).
 *
 * 1600 rather than a tighter 1280: it leaves the 0.6-scale crop probe (1536px
 * off a 2560 capture) untouched, so only the whole-frame probe — which is for
 * cards filling the frame, where pixels are abundant — loses any detail. A QR
 * needs a few pixels per module and synthetic frames decode at 2px/module, but
 * real frames carry sensor noise and motion blur, so the margin is deliberate.
 * Capture stays high-resolution; only the decode surface is bounded.
 */
export const MAX_DECODE_EDGE = 1600;

/** Scale factor that brings `width`x`height` under `MAX_DECODE_EDGE`. */
export function decodeScale(width: number, height: number, cap = MAX_DECODE_EDGE): number {
  return Math.min(1, cap / Math.max(width, height));
}

type ZxingModule = typeof import("@zxing/library");

let zxingPromise: Promise<ZxingModule | null> | null = null;

/** Loaded on demand only — keeps ZXing out of the initial route bundle. */
export function loadZxing(): Promise<ZxingModule | null> {
  if (!zxingPromise) {
    zxingPromise = import("@zxing/library").catch(() => null);
  }
  return zxingPromise;
}

/* ------------------------------------------------------------------ */
/* Preprocessing                                                       */
/* ------------------------------------------------------------------ */

/** Luma (Rec. 601), the plane every decoder actually works on. */
export function toGrayscale(image: ImageData): Uint8ClampedArray {
  const { data, width, height } = image;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    gray[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return gray;
}

/**
 * Percentile contrast stretch. A photocopy often occupies a narrow band of the
 * range (say 90–200 instead of 0–255); pulling it back to full range is enough
 * for a decoder to find module edges.
 */
function contrastStretch(gray: Uint8ClampedArray): Uint8ClampedArray {
  const histogram = new Uint32Array(256);
  for (const value of gray) histogram[value]++;

  const cutoff = Math.floor(gray.length * 0.02);
  let low = 0;
  let high = 255;
  for (let count = 0, i = 0; i < 256; i++) {
    count += histogram[i];
    if (count > cutoff) {
      low = i;
      break;
    }
  }
  for (let count = 0, i = 255; i >= 0; i--) {
    count += histogram[i];
    if (count > cutoff) {
      high = i;
      break;
    }
  }
  if (high <= low) return gray;

  const scale = 255 / (high - low);
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = (gray[i] - low) * scale;
  return out;
}

/** Otsu global threshold — best when the copy is evenly lit. */
function otsuBinarize(gray: Uint8ClampedArray): Uint8ClampedArray {
  const histogram = new Uint32Array(256);
  for (const value of gray) histogram[value]++;

  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance =
      weightBackground *
      weightForeground *
      (meanBackground - meanForeground) *
      (meanBackground - meanForeground);
    if (variance > best) {
      best = variance;
      threshold = t;
    }
  }

  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] > threshold ? 255 : 0;
  return out;
}

/**
 * Adaptive (local mean) threshold via integral image — handles the uneven
 * lighting and shadow gradients typical of a phone photo of a photocopy, which
 * a single global threshold cannot.
 */
function adaptiveBinarize(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * (width + 1) + (x + 1)] =
        integral[y * (width + 1) + (x + 1)] + rowSum;
    }
  }

  // Window ~1/16 of the smaller side keeps several QR modules in view.
  const radius = Math.max(4, Math.floor(Math.min(width, height) / 32));
  const out = new Uint8ClampedArray(gray.length);

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * (width + 1) + (x1 + 1)] -
        integral[y0 * (width + 1) + (x1 + 1)] -
        integral[(y1 + 1) * (width + 1) + x0] +
        integral[y0 * (width + 1) + x0];
      // 6% bias below local mean suppresses paper speckle from a copier.
      out[y * width + x] = gray[y * width + x] * area > sum * 0.94 ? 255 : 0;
    }
  }
  return out;
}

function invert(gray: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = 255 - gray[i];
  return out;
}

function applyVariant(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  variant: Variant,
): Uint8ClampedArray {
  switch (variant) {
    case "stretch":
      return contrastStretch(gray);
    case "otsu":
      return otsuBinarize(contrastStretch(gray));
    case "adaptive":
      return adaptiveBinarize(gray, width, height);
    case "invert":
      return invert(otsuBinarize(contrastStretch(gray)));
    default:
      return gray;
  }
}

/** jsQR needs RGBA, so a processed grey plane is expanded back out. */
function grayToImageData(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
): ImageData {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    rgba[i] = rgba[i + 1] = rgba[i + 2] = gray[p];
    rgba[i + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

/* ------------------------------------------------------------------ */
/* Decoders                                                            */
/* ------------------------------------------------------------------ */

/** Latin-1 text round-trips to bytes 1:1, which is why we ask ZXing for it. */
function latin1ToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function decodeWithZxing(
  zxing: ZxingModule,
  gray: Uint8ClampedArray,
  width: number,
  height: number,
): QrPayload | null {
  try {
    const {
      BarcodeFormat,
      BinaryBitmap,
      DecodeHintType,
      HybridBinarizer,
      MultiFormatReader,
      RGBLuminanceSource,
    } = zxing;

    const hints = new Map<number, unknown>();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    // Force ISO-8859-1 so byte-mode payloads survive as text we can turn back
    // into the exact original bytes. Without it ZXing may guess UTF-8 and
    // corrupt the compressed Secure QR stream.
    hints.set(DecodeHintType.CHARACTER_SET, "ISO-8859-1");

    const reader = new MultiFormatReader();
    reader.setHints(hints);

    const source = new RGBLuminanceSource(gray, width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const result = reader.decode(bitmap, hints);

    const text = result?.getText?.();
    if (!text) return null;
    return latin1ToBytes(text);
  } catch {
    // NotFoundException is the normal "no code in this frame" path.
    return null;
  }
}

function decodeWithJsQr(
  jsQR: JsQrFn,
  image: ImageData,
  options?: JsQrOptions,
): QrPayload | null {
  try {
    const code = jsQR(image.data, image.width, image.height, options);
    if (!code) return null;
    if (code.binaryData?.length) return Uint8Array.from(code.binaryData);
    return code.data || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Cascade                                                             */
/* ------------------------------------------------------------------ */

export type MultiPassOptions = {
  jsQR?: JsQrFn;
  zxing?: ZxingModule | null;
  variants?: Variant[];
  jsQrOptions?: JsQrOptions;
};

/**
 * Try one image every configured way, cheapest first. Returns the first
 * payload found, preferring bytes over text.
 */
export function decodeImageMultiPass(
  image: ImageData,
  { jsQR, zxing, variants = FAST_VARIANTS, jsQrOptions }: MultiPassOptions,
): QrPayload | null {
  const { width, height } = image;
  if (width < 40 || height < 40) return null;

  const gray = toGrayscale(image);

  for (const variant of variants) {
    const processed = applyVariant(gray, width, height, variant);

    // ZXing first: strongest on dense and damaged codes.
    if (zxing) {
      const hit = decodeWithZxing(zxing, processed, width, height);
      if (hit) return hit;
    }

    if (jsQR) {
      const hit = decodeWithJsQr(
        jsQR,
        variant === "raw" ? image : grayToImageData(processed, width, height),
        jsQrOptions,
      );
      if (hit) return hit;
    }
  }

  return null;
}

/**
 * Crop/scale windows to try, widest first. A card held close reads from the
 * full frame; a card lying on a desk reads from a centre crop, which also
 * raises effective resolution on the dense Secure QR.
 */
export function cropRegions(
  source: CanvasImageSource,
  width: number,
  height: number,
  scales: number[],
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }[] {
  const regions: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }[] = [];
  for (const scale of scales) {
    const cw = Math.floor(width * scale);
    const ch = Math.floor(height * scale);
    if (cw < 80 || ch < 80) continue;

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) continue;
    ctx.drawImage(
      source,
      Math.floor((width - cw) / 2),
      Math.floor((height - ch) / 2),
      cw,
      ch,
      0,
      0,
      cw,
      ch,
    );
    regions.push({ canvas, ctx });
  }
  return regions;
}

/**
 * Upscale a small/dense code so its modules span enough pixels for the
 * decoders' grid detection. Smoothing off keeps module edges hard. The cap
 * ensures we stay responsive even on high-res devices.
 */
export function upscale(
  source: CanvasImageSource,
  width: number,
  height: number,
  factor = 2,
  cap = MAX_DECODE_EDGE,
): ImageData | null {
  const targetWidth = width * factor;
  const targetHeight = height * factor;
  const scale = decodeScale(targetWidth, targetHeight, cap);
  const finalWidth = Math.floor(targetWidth * scale);
  const finalHeight = Math.floor(targetHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = finalWidth;
  canvas.height = finalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, finalWidth, finalHeight);
  return ctx.getImageData(0, 0, finalWidth, finalHeight);
}
