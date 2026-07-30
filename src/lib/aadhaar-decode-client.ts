"use client";

/**
 * Main-thread front door to the camera-only Aadhaar decode worker.
 *
 * The worker owns the decoder engines and payload parser; this module owns its
 * lifetime and transfers live frames without copying their pixel buffers.
 */

import * as Comlink from "comlink";
import type { AadhaarDecodeApi, DecodeOutcome } from "@/lib/aadhaar-decode.worker";

export type { DecodeOutcome };

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

/** Release the decoder engines and WASM heap when leaving registration. */
export function disposeDecoder(): void {
  if (!handle) return;
  handle.api[Comlink.releaseProxy]();
  handle.worker.terminate();
  handle = null;
}

/** Decode one bounded live frame, transferring rather than cloning its pixels. */
export function decodeFrame(
  image: ImageData,
  thorough = false,
): Promise<DecodeOutcome> {
  return getWorker().api.decodeFrame(
    Comlink.transfer(image, [image.data.buffer]),
    thorough,
  );
}

/** Parse one complete keyboard-wedge payload in the existing worker. */
export function decodePayload(payload: string): Promise<DecodeOutcome> {
  return getWorker().api.decodePayload(payload);
}
