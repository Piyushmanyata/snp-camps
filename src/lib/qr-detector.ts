/**
 * QR capability detection for desk scanners (#44 / #49).
 * Native BarcodeDetector only when formats include qr_code — constructor
 * presence alone is insufficient (Play Services / Windows).
 */

export type DetectedBarcode = { rawValue: string };

export type BarcodeDetectorInstance = {
  detect: (
    image: HTMLVideoElement | HTMLCanvasElement | ImageBitmap,
  ) => Promise<DetectedBarcode[]>;
};

export type BarcodeDetectorConstructor = new (options?: {
  formats: string[];
}) => BarcodeDetectorInstance;

type BarcodeDetectorGlobal = BarcodeDetectorConstructor & {
  getSupportedFormats?: () => Promise<string[]>;
};

/**
 * True only when this browsing context can actually decode QR with the
 * platform BarcodeDetector (not merely expose the interface).
 */
export async function canUseNativeQrDetector(): Promise<boolean> {
  try {
    const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorGlobal })
      .BarcodeDetector;
    if (typeof Ctor !== "function") return false;
    if (typeof Ctor.getSupportedFormats !== "function") return false;
    const formats = await Ctor.getSupportedFormats();
    return Array.isArray(formats) && formats.includes("qr_code");
  } catch {
    return false;
  }
}

export function getBarcodeDetectorConstructor(): BarcodeDetectorConstructor | null {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector;
  return typeof Ctor === "function" ? Ctor : null;
}

/** Decode a canvas ImageData with jsQR (dynamic-import payload). */
export function decodeQrFromImageData(
  jsQR: (
    data: Uint8ClampedArray,
    width: number,
    height: number,
  ) => { data: string } | null,
  imageData: ImageData,
): string | null {
  const code = jsQR(imageData.data, imageData.width, imageData.height);
  return code?.data ?? null;
}
