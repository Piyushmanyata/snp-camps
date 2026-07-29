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

export type JsQrOptions = {
  inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst";
};

export type JsQrResult = { data: string; binaryData?: number[] };

export type JsQrFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: JsQrOptions,
) => JsQrResult | null;

/** Decode a canvas ImageData with jsQR (dynamic-import payload). */
export function decodeQrFromImageData(
  jsQR: JsQrFn,
  imageData: ImageData,
  options?: JsQrOptions,
): string | null {
  const code = jsQR(imageData.data, imageData.width, imageData.height, options);
  return code?.data ?? null;
}

/**
 * Decode returning the raw byte payload alongside the text.
 *
 * Aadhaar Secure QR is byte-mode binary (a gzip stream), and jsQR's `data` is a
 * lossy UTF-8 decode of those bytes — unusable for decompression. `binaryData`
 * is the only faithful copy, so anything parsing Aadhaar must use this.
 */
export function decodeQrPayloadFromImageData(
  jsQR: JsQrFn,
  imageData: ImageData,
  options?: JsQrOptions,
): { text: string; bytes: Uint8Array | null } | null {
  const code = jsQR(imageData.data, imageData.width, imageData.height, options);
  if (!code) return null;
  return {
    text: code.data ?? "",
    bytes: code.binaryData?.length ? Uint8Array.from(code.binaryData) : null,
  };
}

/**
 * Best-effort camera tuning for dense QR: continuous autofocus is what makes a
 * 137-module Aadhaar Secure QR resolvable at all, and a mild zoom fills more of
 * the sensor with the code. Unsupported constraints are ignored per platform.
 */
export async function applyBestEffortCameraConstraints(
  stream: MediaStream,
): Promise<void> {
  try {
    const track = stream.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() as
      | { focusMode?: string[]; zoom?: { min: number; max: number } }
      | undefined;
    if (caps?.focusMode?.includes("continuous")) {
      await track
        .applyConstraints({
          advanced: [{ focusMode: "continuous" }],
        } as unknown as MediaTrackConstraints)
        .catch(() => {});
    }
    if (caps?.zoom && caps.zoom.max > caps.zoom.min) {
      const zoom = Math.min(
        caps.zoom.max,
        2,
        Math.max(caps.zoom.min, (caps.zoom.min + caps.zoom.max) * 0.25),
      );
      await track
        .applyConstraints({
          advanced: [{ zoom }],
        } as unknown as MediaTrackConstraints)
        .catch(() => {});
    }
  } catch {
    /* ignore unsupported constraints */
  }
}
