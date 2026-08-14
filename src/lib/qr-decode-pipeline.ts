
export type QrPayload = string | Uint8Array;

export type Variant = "raw" | "stretch" | "otsu" | "adaptive" | "invert";

export const FAST_VARIANTS: Variant[] = ["raw"];
export const THOROUGH_VARIANTS: Variant[] = [
  "raw",
  "stretch",
  "otsu",
  "adaptive",
];

export {
  AADHAAR_PROBES,
  MAX_DECODE_EDGE,
  decodeScale,
  probeSurface,
  type Probe,
} from "@/lib/qr-decode-geometry";

let wasmBase = "/wasm/";
let zxingWasmBinary: ArrayBuffer | null = null;

export function setDecoderWasmBase(
  base: string,
  options: { zxingWasmBinary?: ArrayBuffer } = {},
): void {
  wasmBase = base;
  zxingWasmBinary = options.zxingWasmBinary ?? null;
  zxingPromise = null;
  zbarPromise = null;
}

type ZxingReader = typeof import("zxing-wasm/reader");
type ZbarModule = typeof import("@undecaf/zbar-wasm");

let zxingPromise: Promise<ZxingReader | null> | null = null;
let zbarPromise: Promise<ZbarModule | null> | null = null;

export function loadZxing(): Promise<ZxingReader | null> {
  if (!zxingPromise) {
    zxingPromise = import("zxing-wasm/reader")
      .then((module) => {
        module.prepareZXingModule({
          overrides: zxingWasmBinary
            ? { wasmBinary: zxingWasmBinary }
            : {
                locateFile: (path: string, prefix: string) =>
                  path.endsWith(".wasm")
                    ? `${wasmBase}zxing_reader.wasm`
                    : prefix + path,
              },
        });
        return module;
      })
      .catch(() => {
        zxingPromise = null;
        return null;
      });
  }
  return zxingPromise;
}

export function loadZbar(): Promise<ZbarModule | null> {
  if (!zbarPromise) {
    zbarPromise = import("@undecaf/zbar-wasm")
      .then((module) => {
        module.setModuleArgs({
          locateFile: (file: string) =>
            file.endsWith(".wasm") ? `${wasmBase}zbar.wasm` : file,
        });
        return module;
      })
      .catch(() => {
        zbarPromise = null;
        return null;
      });
  }
  return zbarPromise;
}

export async function preloadDecoders(): Promise<void> {
  await Promise.all([loadZxing(), loadZbar()]);
}

export function toGrayscale(image: ImageData): Uint8ClampedArray {
  const { data, width, height } = image;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    gray[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return gray;
}

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

export function grayToImageData(
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

const ZXING_OPTIONS: import("zxing-wasm/reader").ReaderOptions = {
  formats: ["QRCode"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  tryDenoise: true,
  binarizer: "LocalAverage",
  maxNumberOfSymbols: 1,
};

async function decodeWithZxing(
  zxing: ZxingReader,
  image: ImageData,
): Promise<Uint8Array | null> {
  try {
    const results = await zxing.readBarcodes(image, ZXING_OPTIONS);
    for (const result of results) {
      if (result?.isValid && result.bytes?.length) return new Uint8Array(result.bytes);
    }
    return null;
  } catch {
    return null;
  }
}

async function decodeWithZbar(
  zbar: ZbarModule,
  image: ImageData,
): Promise<Uint8Array | null> {
  try {
    const symbols = await zbar.scanImageData(image);
    for (const symbol of symbols) {
      if (symbol.type !== zbar.ZBarSymbolType.ZBAR_QRCODE) continue;
      if (!symbol.data?.length) continue;
      return new Uint8Array(symbol.data.buffer.slice(0), 0, symbol.data.length);
    }
    return null;
  } catch {
    return null;
  }
}

export type MultiPassOptions = {
  zxing?: ZxingReader | null;
  zbar?: ZbarModule | null;
  variants?: Variant[];
};

export async function decodeImageMultiPass(
  image: ImageData,
  { zxing, zbar, variants = FAST_VARIANTS }: MultiPassOptions,
): Promise<QrPayload | null> {
  const { width, height } = image;
  if (width < 40 || height < 40) return null;

  const gray = toGrayscale(image);

  for (const variant of variants) {
    const processed =
      variant === "raw" ? null : applyVariant(gray, width, height, variant);
    const candidate =
      processed === null ? image : grayToImageData(processed, width, height);

    if (zxing) {
      const hit = await decodeWithZxing(zxing, candidate);
      if (hit) return hit;
    }

    if (zbar) {
      const hit = await decodeWithZbar(zbar, candidate);
      if (hit) return hit;
    }
  }

  return null;
}
