
import * as Comlink from "comlink";
import {
  FAST_VARIANTS,
  THOROUGH_VARIANTS,
  decodeImageMultiPass,
  loadZbar,
  loadZxing,
  type QrPayload,
} from "@/lib/qr-decode-pipeline";
import {
  describeQrPayload,
  parseAadhaarQrAsync,
  type ParsedAadhaarQr,
} from "@/lib/aadhaar-qr";

export type DecodeOutcome =
  | { status: "parsed"; parsed: ParsedAadhaarQr; diagnostic: string }
  | { status: "rejected"; message: string; diagnostic: string }
  | { status: "malformed"; message: string; diagnostic: string }
  | { status: "none" };

async function toOutcome(payload: QrPayload): Promise<DecodeOutcome> {
  const diagnostic = describeQrPayload(payload);
  try {
    const parsed = await parseAadhaarQrAsync(payload);
    return { status: "parsed", parsed, diagnostic };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Invalid Aadhaar QR code.";
    if (/desk slip/i.test(message)) {
      return { status: "rejected", message, diagnostic };
    }
    return {
      status: "malformed",
      message:
        "A QR was found, but its Aadhaar data was incomplete or unsupported. Retake the photo or try another method.",
      diagnostic,
    };
  }
}

const api = {
  async warmUp(): Promise<void> {
    await loadZxing();
  },

  async decodeFrame(image: ImageData, thorough = false): Promise<DecodeOutcome> {
    const variants = thorough ? THOROUGH_VARIANTS : FAST_VARIANTS;
    const zxing = await loadZxing();
    let payload = zxing
      ? await decodeImageMultiPass(image, { zxing, variants })
      : null;

    if (!payload && (thorough || !zxing)) {
      const zbar = await loadZbar();
      if (zbar) {
        payload = await decodeImageMultiPass(image, { zbar, variants });
      }
    }
    return payload ? toOutcome(payload) : { status: "none" };
  },

  async decodePayload(payload: string): Promise<DecodeOutcome> {
    if (payload.length < 20 || payload.length > 16_384) {
      return {
        status: "malformed",
        message: "The USB scanner returned an incomplete Aadhaar payload. Scan the card again.",
        diagnostic: `kind=usb;len=${payload.length};accepted=false`,
      };
    }
    return toOutcome(payload);
  },
};

export type AadhaarDecodeApi = typeof api;

Comlink.expose(api);
