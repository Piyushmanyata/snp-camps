/**
 * Aadhaar decode worker.
 *
 * Everything expensive lives here: both WASM decoder engines and the payload
 * parser. Keeping that work off the main thread lets the camera preview remain
 * responsive on low-end Android devices.
 *
 * Exposed to the page through Comlink; see `aadhaar-decode-client.ts`.
 */

import * as Comlink from "comlink";
import {
  FAST_VARIANTS,
  THOROUGH_VARIANTS,
  decodeImageMultiPass,
  loadZbar,
  loadZxing,
  preloadDecoders,
  type QrPayload,
} from "@/lib/qr-decode-pipeline";
import {
  describeQrPayload,
  parseAadhaarQrAsync,
  type ParsedAadhaarQr,
} from "@/lib/aadhaar-qr";

export type DecodeOutcome =
  | { status: "parsed"; parsed: ParsedAadhaarQr; diagnostic: string }
  /** A QR was read but it is not an Aadhaar card (typically our own desk slip). */
  | { status: "rejected"; message: string; diagnostic: string }
  /** No QR found in this image at all. */
  | { status: "none" };

async function engines() {
  const [zxing, zbar] = await Promise.all([loadZxing(), loadZbar()]);
  return { zxing, zbar };
}

/** Turn a decoded payload into an outcome, keeping errors operator-facing. */
async function toOutcome(payload: QrPayload): Promise<DecodeOutcome> {
  const diagnostic = describeQrPayload(payload);
  try {
    const parsed = await parseAadhaarQrAsync(payload);
    return { status: "parsed", parsed, diagnostic };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Invalid Aadhaar QR code.";
    // "Unreadable" on a payload we did decode means the format is one we do not
    // understand yet — not a terminal rejection, so the caller may keep trying
    // other frames or rescue variants.
    if (/desk slip/i.test(message)) {
      return { status: "rejected", message, diagnostic };
    }
    return { status: "none" };
  }
}

/* ------------------------------------------------------------------ */
/* Worker API                                                          */
/* ------------------------------------------------------------------ */

const api = {
  /** Warm both engines while the operator is still aiming the camera. */
  async warmUp(): Promise<void> {
    await preloadDecoders();
  },

  /**
   * One live camera frame. Cheap by construction: a single variant, both
   * engines, no OpenCV. Called many times a second, so it must never escalate
   * on its own.
   */
  async decodeFrame(image: ImageData, thorough = false): Promise<DecodeOutcome> {
    const { zxing, zbar } = await engines();
    if (!zxing && !zbar) return { status: "none" };
    const payload = await decodeImageMultiPass(image, {
      zxing,
      zbar,
      variants: thorough ? THOROUGH_VARIANTS : FAST_VARIANTS,
    });
    return payload ? toOutcome(payload) : { status: "none" };
  },
};

export type AadhaarDecodeApi = typeof api;

Comlink.expose(api);
