"use client";

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

export function warmUpDecoder(): void {
  void getWorker().api.warmUp();
}

export function disposeDecoder(): void {
  if (!handle) return;
  handle.api[Comlink.releaseProxy]();
  handle.worker.terminate();
  handle = null;
}

export function decodeFrame(
  image: ImageData,
  thorough = false,
): Promise<DecodeOutcome> {
  return getWorker().api.decodeFrame(
    Comlink.transfer(image, [image.data.buffer]),
    thorough,
  );
}

export function decodePayload(payload: string): Promise<DecodeOutcome> {
  return getWorker().api.decodePayload(payload);
}
