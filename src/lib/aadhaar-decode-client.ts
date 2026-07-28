"use client";

/**
 * Main-thread front door to the Aadhaar decode worker.
 *
 * Owns the worker lifetime and turns every input the registration screens
 * accept — a live camera frame, a photo, an iPhone HEIC, a screenshot, an
 * e-Aadhaar PDF — into the one thing the worker understands: `ImageData`.
 */

import * as Comlink from "comlink";
import type { AadhaarDecodeApi, DecodeOutcome } from "@/lib/aadhaar-decode.worker";
import { MAX_DECODE_EDGE } from "@/lib/qr-decode-pipeline";

export type { DecodeOutcome };

/**
 * Decode-surface cap for a still image.
 *
 * Deliberately larger than the live-frame cap: a still is a one-shot the
 * operator is already waiting on, not a loop that has to stay at ~12fps, and a
 * 12-megapixel upload of a whole card can hold the QR in a few hundred pixels.
 * Downscaling that to the live cap destroys the code outright.
 *
 * Do NOT raise the live cap to match — see MAX_DECODE_EDGE, which is measured.
 */
export const MAX_STILL_EDGE = 2400;

/** Raised when an e-Aadhaar PDF needs the share-code password to open. */
export class PdfPasswordRequired extends Error {
  constructor(readonly wrongPassword: boolean) {
    super(
      wrongPassword
        ? "That password did not open the PDF."
        : "This e-Aadhaar PDF is password protected.",
    );
    this.name = "PdfPasswordRequired";
  }
}

type WorkerHandle = {
  worker: Worker;
  api: Comlink.Remote<AadhaarDecodeApi>;
};

let handle: WorkerHandle | null = null;

function getWorker(): WorkerHandle {
  if (!handle) {
    const worker = new Worker(
      new URL("./aadhaar-decode.worker.ts", import.meta.url),
      { type: "module", name: "aadhaar-decode" },
    );
    handle = { worker, api: Comlink.wrap<AadhaarDecodeApi>(worker) };
  }
  return handle;
}

/** Start loading the WASM engines before the first frame needs them. */
export function warmUpDecoder(): void {
  void getWorker().api.warmUp();
}

/**
 * Tear the worker down.
 *
 * Worth doing when leaving the registration screen: the engines hold tens of
 * megabytes of WASM heap, which matters on the low-end Androids these camps
 * actually run on.
 */
export function disposeDecoder(): void {
  if (!handle) return;
  handle.api[Comlink.releaseProxy]();
  handle.worker.terminate();
  handle = null;
}

/**
 * Decode one live camera frame.
 *
 * `ImageData` is transferred, not copied — a 1200x1200 frame is ~5.7MB and
 * structured-cloning that many times a second is itself a frame-rate problem.
 */
export function decodeFrame(
  image: ImageData,
  thorough = false,
): Promise<DecodeOutcome> {
  return getWorker().api.decodeFrame(
    Comlink.transfer(image, [image.data.buffer]),
    thorough,
  );
}

/** Decode a still image through the full cascade plus the OpenCV rescue. */
export function decodeStill(image: ImageData): Promise<DecodeOutcome> {
  return getWorker().api.decodeStill(
    Comlink.transfer(image, [image.data.buffer]),
  );
}

/* ------------------------------------------------------------------ */
/* Input conversion                                                    */
/* ------------------------------------------------------------------ */

function canvasFor(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Draw a decoded bitmap into ImageData, bounded to `maxEdge`. */
export function bitmapToImageData(
  bitmap: ImageBitmap | HTMLImageElement,
  maxEdge = MAX_STILL_EDGE,
): ImageData {
  const width = "width" in bitmap ? bitmap.width : 0;
  const height = "height" in bitmap ? bitmap.height : 0;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));

  const canvas = canvasFor(dw, dh);
  const ctx = (canvas as HTMLCanvasElement).getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("Could not read this image.");

  // Smooth only when shrinking: that averages sensor noise away instead of
  // aliasing it into the QR modules. Magnifying wants hard module edges.
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh);
}

/**
 * Blob to ImageData, honouring EXIF orientation.
 *
 * `imageOrientation: "from-image"` is load-bearing: phone photos are almost
 * always stored rotated with an EXIF flag, and a decoder handed the unrotated
 * pixels sees a sideways card.
 */
async function blobToImageData(blob: Blob, maxEdge: number): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    return bitmapToImageData(bitmap, maxEdge);
  } finally {
    bitmap.close();
  }
}

const PDF_TYPES = ["application/pdf"];

function looksLikePdf(file: File): boolean {
  return PDF_TYPES.includes(file.type) || /\.pdf$/i.test(file.name);
}

/**
 * Render an e-Aadhaar PDF and decode the first page carrying a readable QR.
 *
 * Rendered at a fixed large scale rather than the page's natural size: the QR
 * on an e-Aadhaar occupies a small fraction of an A4 page, so rendering at 1x
 * produces a code too small for any engine.
 */
async function decodePdf(file: File, password?: string): Promise<DecodeOutcome> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url,
  ).toString();

  const data = new Uint8Array(await file.arrayBuffer());
  // The loading task, not the document, owns teardown in pdf.js.
  const loadingTask = pdfjs.getDocument({ data, password });
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (error: unknown) {
    const name = (error as { name?: string })?.name;
    if (name === "PasswordException") {
      throw new PdfPasswordRequired(Boolean(password));
    }
    throw new Error("Could not open this PDF.");
  }

  try {
    // The QR is on page 1 of every e-Aadhaar; the rest is a cheap safety net.
    const pages = Math.min(doc.numPages, 3);
    for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, MAX_STILL_EDGE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });

      const canvas = canvasFor(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      const ctx = (canvas as HTMLCanvasElement).getContext("2d", {
        willReadFrequently: true,
      }) as CanvasRenderingContext2D | null;
      if (!ctx) continue;

      // e-Aadhaar pages are transparent-backed; without this the QR renders
      // black-on-black and nothing decodes.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas: canvas as HTMLCanvasElement, viewport }).promise;

      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const outcome = await decodeStill(image);
      if (outcome.status !== "none") return outcome;
    }
    return { status: "none" };
  } finally {
    doc.cleanup();
    await loadingTask.destroy();
  }
}

/**
 * Decode any file the registration screens accept.
 *
 * This is the path that makes self-registration possible at all: a patient
 * cannot point their phone's camera at a QR displayed on that same phone, so
 * uploading the mAadhaar screenshot or the e-Aadhaar PDF is the only route.
 */
export async function decodeFile(
  file: File,
  options: { pdfPassword?: string } = {},
): Promise<DecodeOutcome> {
  if (looksLikePdf(file)) return decodePdf(file, options.pdfPassword);

  let blob: Blob = file;

  // iPhones hand over HEIC, which no browser can draw to a canvas directly.
  const { isHeic, heicTo } = await import("heic-to");
  if (await isHeic(file).catch(() => false)) {
    blob = await heicTo({ blob: file, type: "image/png" });
  }

  const image = await blobToImageData(blob, MAX_STILL_EDGE);
  return decodeStill(image);
}

/**
 * Decode a user-drawn crop of an image.
 *
 * The crop is expanded slightly before decoding: people box the QR tightly,
 * which cuts into the quiet zone the QR spec requires and makes an otherwise
 * perfect code unreadable.
 */
export async function decodeCrop(
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  rect: { x: number; y: number; width: number; height: number },
): Promise<DecodeOutcome> {
  const pad = Math.round(Math.max(rect.width, rect.height) * 0.08);
  const sx = Math.max(0, rect.x - pad);
  const sy = Math.max(0, rect.y - pad);
  const sw = rect.width + pad * 2;
  const sh = rect.height + pad * 2;

  const scale = Math.min(1, MAX_STILL_EDGE / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  const canvas = canvasFor(dw, dh);
  const ctx = (canvas as HTMLCanvasElement).getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("Could not read this image.");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, dw, dh);
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.drawImage(source as CanvasImageSource, sx, sy, sw, sh, 0, 0, dw, dh);

  return decodeStill(ctx.getImageData(0, 0, dw, dh));
}

export { MAX_DECODE_EDGE };
