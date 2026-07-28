/**
 * Aadhaar decode worker.
 *
 * Everything expensive lives here: both WASM decoder engines, the OpenCV rescue
 * cascade, and the payload parse. On a low-end Android the cascade is hundreds
 * of milliseconds per attempt, and running it on the main thread is what turns
 * a slow scan into a frozen UI — the camera preview stops repainting and the
 * operator concludes the app has crashed.
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

/** Rescue transform applied to a still image before retrying both engines. */
export type RescueStep =
  | "original"
  | "upscale-1.5x"
  | "upscale-2x"
  | "border"
  | "clahe"
  | "sharpen"
  | "detected-crop"
  | "perspective";

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
/* OpenCV rescue                                                       */
/* ------------------------------------------------------------------ */

type Cv = typeof import("@techstark/opencv-js");
let cvPromise: Promise<Cv | null> | null = null;

/**
 * OpenCV is ~13MB and is only ever needed once the cheap passes have failed, so
 * it is loaded on the rescue path and never on the live camera path. A clean
 * card never pays for it.
 */
function loadCv(): Promise<Cv | null> {
  if (!cvPromise) {
    cvPromise = import("@techstark/opencv-js")
      .then(async (module) => {
        const cv = (module.default ?? module) as Cv & {
          onRuntimeInitialized?: () => void;
          Mat?: unknown;
        };
        if (cv.Mat) return cv;
        await new Promise<void>((resolve) => {
          cv.onRuntimeInitialized = () => resolve();
          // Some builds initialise before the handler is attached.
          if (cv.Mat) resolve();
        });
        return cv;
      })
      .catch(() => null);
  }
  return cvPromise;
}

/** Scale an ImageData by `factor` using OpenCV's cubic interpolation. */
function upscale(cv: Cv, src: ImageData, factor: number): ImageData {
  const mat = cv.matFromImageData(src);
  const out = new cv.Mat();
  try {
    cv.resize(
      mat,
      out,
      new cv.Size(Math.round(src.width * factor), Math.round(src.height * factor)),
      0,
      0,
      cv.INTER_CUBIC,
    );
    return new ImageData(
      new Uint8ClampedArray(out.data),
      out.cols,
      out.rows,
    );
  } finally {
    mat.delete();
    out.delete();
  }
}

/**
 * Add a white quiet zone. A QR cropped flush to its modules is unreadable —
 * the spec requires a 4-module margin, and a tight manual crop or a card
 * photographed edge-on routinely loses it.
 */
function addBorder(cv: Cv, src: ImageData): ImageData {
  const mat = cv.matFromImageData(src);
  const out = new cv.Mat();
  const pad = Math.max(16, Math.round(Math.min(src.width, src.height) * 0.08));
  try {
    cv.copyMakeBorder(
      mat,
      out,
      pad,
      pad,
      pad,
      pad,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255, 255, 255, 255),
    );
    return new ImageData(new Uint8ClampedArray(out.data), out.cols, out.rows);
  } finally {
    mat.delete();
    out.delete();
  }
}

/**
 * CLAHE — local histogram equalisation. This is the one preprocessing step the
 * plain JS cascade cannot reproduce: it lifts contrast per tile, so a photocopy
 * that is washed out in one corner and dark in another comes back even.
 */
function clahe(cv: Cv, src: ImageData): ImageData {
  const mat = cv.matFromImageData(src);
  const gray = new cv.Mat();
  const equalised = new cv.Mat();
  const rgba = new cv.Mat();
  const filter = new cv.CLAHE(2.0, new cv.Size(8, 8));
  try {
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    filter.apply(gray, equalised);
    cv.cvtColor(equalised, rgba, cv.COLOR_GRAY2RGBA);
    return new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  } finally {
    mat.delete();
    gray.delete();
    equalised.delete();
    rgba.delete();
    filter.delete();
  }
}

/** Mild unsharp mask — recovers module edges lost to defocus or motion blur. */
function sharpen(cv: Cv, src: ImageData): ImageData {
  const mat = cv.matFromImageData(src);
  const blurred = new cv.Mat();
  const out = new cv.Mat();
  try {
    cv.GaussianBlur(mat, blurred, new cv.Size(0, 0), 3);
    cv.addWeighted(mat, 1.5, blurred, -0.5, 0, out);
    return new ImageData(new Uint8ClampedArray(out.data), out.cols, out.rows);
  } finally {
    mat.delete();
    blurred.delete();
    out.delete();
  }
}

/**
 * Locate the QR and return a de-skewed, upright crop of just that region.
 *
 * This is what rescues the common upload: a whole Aadhaar card photographed at
 * an angle from a metre away, where the QR is a few hundred pixels in a
 * multi-megapixel frame. `QRCodeDetector` finds the four corners even when it
 * cannot decode, so the corners alone are useful — a perspective warp onto a
 * square then hands the engines a flat, correctly-scaled code.
 */
function detectAndRectify(cv: Cv, src: ImageData): ImageData | null {
  const mat = cv.matFromImageData(src);
  const points = new cv.Mat();
  const detector = new cv.QRCodeDetector();
  let warped: ImageData | null = null;
  try {
    if (!detector.detect(mat, points) || points.rows * points.cols < 4) {
      return null;
    }

    // Four corners, clockwise from top-left, as flat [x,y,...] floats.
    const corners: number[] = [];
    for (let i = 0; i < 4; i++) {
      corners.push(points.floatAt(0, i * 2), points.floatAt(0, i * 2 + 1));
    }

    // Target size from the longest detected edge, floored so a tiny detection
    // still lands well above the ~3px/module readability threshold.
    const edge = Math.hypot(corners[2] - corners[0], corners[3] - corners[1]);
    const side = Math.max(320, Math.min(1200, Math.round(edge * 1.2)));

    const from = cv.matFromArray(4, 1, cv.CV_32FC2, corners);
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0, side, 0, side, side, 0, side,
    ]);
    const transform = cv.getPerspectiveTransform(from, to);
    const out = new cv.Mat();
    try {
      cv.warpPerspective(
        mat,
        out,
        transform,
        new cv.Size(side, side),
        cv.INTER_CUBIC,
        cv.BORDER_CONSTANT,
        new cv.Scalar(255, 255, 255, 255),
      );
      warped = new ImageData(new Uint8ClampedArray(out.data), out.cols, out.rows);
    } finally {
      from.delete();
      to.delete();
      transform.delete();
      out.delete();
    }
    return warped;
  } catch {
    return null;
  } finally {
    mat.delete();
    points.delete();
    detector.delete();
  }
}

/**
 * Rescue variants for one still image, cheapest first.
 *
 * Each is an *independent* retry of the original, never a chain: some
 * preprocessing rescues one card and destroys another, so an enhanced image
 * must not replace the original for the next attempt.
 */
function* rescueVariants(
  cv: Cv,
  original: ImageData,
): Generator<[RescueStep, ImageData]> {
  const safe = (step: RescueStep, make: () => ImageData | null) => {
    try {
      const image = make();
      return image ? ([step, image] as [RescueStep, ImageData]) : null;
    } catch {
      return null;
    }
  };

  // Detection first: when it works it is both the cheapest win and the one that
  // fixes angle, scale and quiet zone in a single step.
  const rectified = safe("perspective", () => detectAndRectify(cv, original));
  if (rectified) yield rectified;

  for (const candidate of [
    safe("border", () => addBorder(cv, original)),
    safe("clahe", () => clahe(cv, original)),
    safe("sharpen", () => sharpen(cv, original)),
    safe("upscale-1.5x", () => upscale(cv, original, 1.5)),
    safe("upscale-2x", () => upscale(cv, original, 2)),
    // A rectified crop that would not decode plain is often readable once its
    // contrast is evened out.
    rectified ? safe("detected-crop", () => clahe(cv, rectified[1])) : null,
  ]) {
    if (candidate) yield candidate;
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

  /**
   * A still image — an upload, a captured photo, or a rendered PDF page.
   *
   * Runs the full preprocessing cascade first, then the OpenCV rescue variants,
   * retrying **both** engines after every transform. This is the path allowed
   * to be slow: the operator is waiting on one image, not a live preview.
   */
  async decodeStill(image: ImageData): Promise<DecodeOutcome> {
    const { zxing, zbar } = await engines();
    if (!zxing && !zbar) return { status: "none" };

    const attempt = async (candidate: ImageData): Promise<DecodeOutcome | null> => {
      const payload = await decodeImageMultiPass(candidate, {
        zxing,
        zbar,
        variants: THOROUGH_VARIANTS,
      });
      if (!payload) return null;
      const outcome = await toOutcome(payload);
      // A decoded-but-unparseable payload should not stop the cascade: another
      // variant may read the code correctly where this one read it corrupted.
      return outcome.status === "none" ? null : outcome;
    };

    const direct = await attempt(image);
    if (direct) return direct;

    const cv = await loadCv();
    if (!cv) return { status: "none" };

    for (const [, candidate] of rescueVariants(cv, image)) {
      const outcome = await attempt(candidate);
      if (outcome) return outcome;
    }

    return { status: "none" };
  },
};

export type AadhaarDecodeApi = typeof api;

Comlink.expose(api);
