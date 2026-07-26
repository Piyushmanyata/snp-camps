/**
 * Station-local A4 multi-up batch queue (#64).
 *
 * Stores only patient UUIDs + enqueue timestamps — never name/phone/Aadhaar/
 * status-token. Bounded to four distinct IDs. Browser print completion is not
 * knowable, so the queue stays until the operator explicitly clears / starts
 * a new sheet after physical confirmation.
 */

import { isPatientUuid } from "@/lib/qr";

export const A4_BATCH_MAX = 4;
export const A4_BATCH_STORAGE_KEY = "snp.a4BatchQueue";

export type A4BatchEntry = {
  /** Patient UUID only — no PII. */
  id: string;
  /** Unix ms when the id was enqueued (for recovery ordering). */
  addedAt: number;
};

export type A4BatchQueue = {
  /** Schema version for future migrations. */
  v: 1;
  entries: A4BatchEntry[];
};

const listeners = new Set<() => void>();

/** Stable empty snapshot for useSyncExternalStore (must not allocate per call). */
const EMPTY_QUEUE: A4BatchQueue = Object.freeze({
  v: 1,
  entries: Object.freeze([]) as unknown as A4BatchEntry[],
}) as A4BatchQueue;

/** Cached client snapshot — same reference until storage write changes content. */
let cachedClientSnapshot: A4BatchQueue = EMPTY_QUEUE;

export function emptyA4BatchQueue(): A4BatchQueue {
  return { v: 1, entries: [] };
}

function queuesEqual(a: A4BatchQueue, b: A4BatchQueue): boolean {
  if (a === b) return true;
  if (a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i += 1) {
    const x = a.entries[i]!;
    const y = b.entries[i]!;
    if (x.id !== y.id || x.addedAt !== y.addedAt) return false;
  }
  return true;
}

/** Normalize unknown storage JSON into a bounded distinct queue. */
export function parseA4BatchQueue(raw: unknown): A4BatchQueue {
  if (!raw || typeof raw !== "object") return emptyA4BatchQueue();
  const obj = raw as { v?: unknown; entries?: unknown };
  if (!Array.isArray(obj.entries)) return emptyA4BatchQueue();

  const seen = new Set<string>();
  const entries: A4BatchEntry[] = [];
  for (const item of obj.entries) {
    if (!item || typeof item !== "object") continue;
    const id = typeof (item as { id?: unknown }).id === "string"
      ? (item as { id: string }).id.trim().toLowerCase()
      : "";
    if (!isPatientUuid(id) || seen.has(id)) continue;
    const addedAtRaw = (item as { addedAt?: unknown }).addedAt;
    const addedAt =
      typeof addedAtRaw === "number" && Number.isFinite(addedAtRaw)
        ? addedAtRaw
        : Date.now();
    seen.add(id);
    entries.push({ id, addedAt });
    if (entries.length >= A4_BATCH_MAX) break;
  }
  return { v: 1, entries };
}

export function a4BatchIds(queue: A4BatchQueue): string[] {
  return queue.entries.map((e) => e.id);
}

export function a4BatchCount(queue: A4BatchQueue): number {
  return queue.entries.length;
}

export function a4BatchIsFull(queue: A4BatchQueue): boolean {
  return queue.entries.length >= A4_BATCH_MAX;
}

export function a4BatchIsEmpty(queue: A4BatchQueue): boolean {
  return queue.entries.length === 0;
}

/**
 * Add a distinct patient id. Returns the new queue and whether the id was
 * newly added (false when already present or invalid).
 * Does not evict older entries when full — operator must print/clear first.
 */
export function addToA4Batch(
  queue: A4BatchQueue,
  patientId: string,
  now = Date.now(),
): { queue: A4BatchQueue; added: boolean; reason?: "invalid" | "duplicate" | "full" } {
  const id = typeof patientId === "string" ? patientId.trim().toLowerCase() : "";
  if (!isPatientUuid(id)) {
    return { queue, added: false, reason: "invalid" };
  }
  if (queue.entries.some((e) => e.id === id)) {
    return { queue, added: false, reason: "duplicate" };
  }
  if (queue.entries.length >= A4_BATCH_MAX) {
    return { queue, added: false, reason: "full" };
  }
  return {
    queue: {
      v: 1,
      entries: [...queue.entries, { id, addedAt: now }],
    },
    added: true,
  };
}

export function clearA4Batch(): A4BatchQueue {
  return emptyA4BatchQueue();
}

/** Same-origin path for the multi-up batch sheet. */
export function a4BatchPrintPath(ids: readonly string[]): string {
  const clean = ids
    .map((id) => id.trim().toLowerCase())
    .filter((id) => isPatientUuid(id))
    .slice(0, A4_BATCH_MAX);
  if (clean.length === 0) return "/print/batch";
  return `/print/batch?ids=${encodeURIComponent(clean.join(","))}${
    clean.length > 0 ? "&auto=1" : ""
  }`;
}

/** Path without auto-print (preview / reprint). */
export function a4BatchPreviewPath(ids: readonly string[]): string {
  const clean = ids
    .map((id) => id.trim().toLowerCase())
    .filter((id) => isPatientUuid(id))
    .slice(0, A4_BATCH_MAX);
  if (clean.length === 0) return "/print/batch";
  return `/print/batch?ids=${encodeURIComponent(clean.join(","))}`;
}

export function parseA4BatchIdsParam(
  raw: string | null | undefined,
): string[] {
  if (!raw || typeof raw !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const id = part.trim().toLowerCase();
    if (!isPatientUuid(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= A4_BATCH_MAX) break;
  }
  return out;
}

// ---- localStorage + useSyncExternalStore helpers (client only) ----

export function readA4BatchFromStorage(): A4BatchQueue {
  if (typeof window === "undefined") return EMPTY_QUEUE;
  try {
    const raw = window.localStorage.getItem(A4_BATCH_STORAGE_KEY);
    if (!raw) {
      cachedClientSnapshot = EMPTY_QUEUE;
      return cachedClientSnapshot;
    }
    const next = parseA4BatchQueue(JSON.parse(raw));
    if (queuesEqual(cachedClientSnapshot, next)) {
      return cachedClientSnapshot;
    }
    cachedClientSnapshot = next;
    return cachedClientSnapshot;
  } catch {
    cachedClientSnapshot = EMPTY_QUEUE;
    return cachedClientSnapshot;
  }
}

export function writeA4BatchToStorage(queue: A4BatchQueue): void {
  if (typeof window === "undefined") return;
  // Persist only id + addedAt — never name/phone/token.
  const payload: A4BatchQueue = {
    v: 1,
    entries: queue.entries.slice(0, A4_BATCH_MAX).map((e) => ({
      id: e.id,
      addedAt: e.addedAt,
    })),
  };
  try {
    window.localStorage.setItem(A4_BATCH_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // private mode / quota — listeners still update this tab
  }
  if (!queuesEqual(cachedClientSnapshot, payload)) {
    cachedClientSnapshot = payload;
  }
  for (const listener of listeners) listener();
}

export function subscribeA4Batch(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStoreChange);
  }
  return () => {
    listeners.delete(onStoreChange);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStoreChange);
    }
  };
}

export function getA4BatchServerSnapshot(): A4BatchQueue {
  return EMPTY_QUEUE;
}

/**
 * Enqueue a patient on the station A4 queue. Returns the updated queue and
 * whether the id was newly added.
 */
export function enqueueA4BatchPatient(
  patientId: string,
  now = Date.now(),
): { queue: A4BatchQueue; added: boolean; reason?: "invalid" | "duplicate" | "full" } {
  const current = readA4BatchFromStorage();
  const result = addToA4Batch(current, patientId, now);
  if (result.added) {
    writeA4BatchToStorage(result.queue);
  }
  return result;
}

export function clearA4BatchStorage(): A4BatchQueue {
  const empty = clearA4Batch();
  writeA4BatchToStorage(empty);
  return empty;
}
