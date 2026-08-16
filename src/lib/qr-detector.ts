
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

export function decodeQrFromImageData(
  jsQR: JsQrFn,
  imageData: ImageData,
  options?: JsQrOptions,
): string | null {
  const code = jsQR(imageData.data, imageData.width, imageData.height, options);
  return code?.data ?? null;
}

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
  }
}
