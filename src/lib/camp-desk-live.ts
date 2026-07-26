/**
 * Camp-keyed desk snapshot owner (#56).
 * One shared poller per campId across queue + seats on a page.
 * Pure module — no React; polling only.
 */

import {
  fetchDeskLive,
  type DeskLivePayload,
  type DeskLiveWaitingRow,
} from "@/lib/desk-live";
import { POLL_MS } from "@/lib/poll";
import type { CampDayStats } from "@/lib/types";

export type DeskLiveFreshness = "fresh" | "refreshing" | "stale-error" | "off";

export type DeskLiveView = {
  campId: string | null;
  waiting: DeskLiveWaitingRow[];
  waitingTotal: number;
  days: CampDayStats[];
  freshness: DeskLiveFreshness;
  /** Monotonic generation; only the latest non-aborted apply wins. */
  generation: number;
  pendingRemovals: ReadonlySet<string>;
};

export type DeskLiveSeed = {
  waiting?: DeskLiveWaitingRow[];
  waitingTotal?: number;
  days?: CampDayStats[];
};

type Listener = (view: DeskLiveView) => void;

type Owner = {
  campId: string;
  generation: number;
  waiting: DeskLiveWaitingRow[];
  waitingTotal: number;
  days: CampDayStats[];
  freshness: DeskLiveFreshness;
  pendingRemovals: Set<string>;
  listeners: Set<Listener>;
  abort: AbortController | null;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** True after first successful client fetch for this camp. */
  hasClientSnapshot: boolean;
};

const owners = new Map<string, Owner>();

function emptyView(campId: string | null): DeskLiveView {
  return {
    campId,
    waiting: [],
    waitingTotal: 0,
    days: [],
    freshness: campId ? "refreshing" : "off",
    generation: 0,
    pendingRemovals: new Set(),
  };
}

function snapshot(owner: Owner): DeskLiveView {
  const pending = owner.pendingRemovals;
  const waiting =
    pending.size === 0
      ? owner.waiting
      : owner.waiting.filter((row) => !pending.has(row.id));
  const removed = owner.waiting.length - waiting.length;
  return {
    campId: owner.campId,
    waiting,
    waitingTotal: Math.max(0, owner.waitingTotal - removed),
    days: owner.days,
    freshness: owner.freshness,
    generation: owner.generation,
    pendingRemovals: new Set(pending),
  };
}

function emit(owner: Owner) {
  const view = snapshot(owner);
  for (const listener of owner.listeners) {
    listener(view);
  }
}

function clearTimer(owner: Owner) {
  if (owner.timer != null) {
    clearTimeout(owner.timer);
    owner.timer = null;
  }
}

function schedule(owner: Owner) {
  clearTimer(owner);
  if (owner.listeners.size === 0) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return;
  }
  owner.timer = setTimeout(() => {
    owner.timer = null;
    void runFetch(owner, { reason: "poll" });
  }, POLL_MS);
}

async function runFetch(
  owner: Owner,
  options: { reason: "poll" | "manual" | "visibility" | "subscribe" },
) {
  if (owner.listeners.size === 0) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    if (options.reason === "poll") {
      schedule(owner);
    }
    return;
  }
  if (owner.inFlight) {
    // Never stack ordinary polls. Manual / visibility abort the in-flight
    // request and start a newer generation.
    if (options.reason === "manual" || options.reason === "visibility") {
      owner.abort?.abort();
      owner.inFlight = false;
    } else {
      return;
    }
  }

  const generation = owner.generation + 1;
  owner.generation = generation;
  const abort = new AbortController();
  owner.abort = abort;
  owner.inFlight = true;
  owner.freshness = "refreshing";
  emit(owner);

  try {
    const data = await fetchDeskLive(owner.campId, { signal: abort.signal });
    if (generation !== owner.generation) return;
    applyPayload(owner, data);
    owner.freshness = "fresh";
    owner.hasClientSnapshot = true;
    // Reconcile pending removals against server: drop IDs still present.
    for (const id of [...owner.pendingRemovals]) {
      if (data.waiting.some((row) => row.id === id)) {
        // Still waiting server-side — keep pending only if mutation in flight;
        // optimistic removal that server still shows: clear so user sees truth.
        owner.pendingRemovals.delete(id);
      } else {
        owner.pendingRemovals.delete(id);
      }
    }
    emit(owner);
  } catch {
    if (abort.signal.aborted || generation !== owner.generation) return;
    // Preserve already-loaded rows; visibly mark stale (not empty success).
    owner.freshness = "stale-error";
    emit(owner);
  } finally {
    if (generation === owner.generation) {
      owner.inFlight = false;
      owner.abort = null;
      schedule(owner);
    }
  }
}

function applyPayload(owner: Owner, data: DeskLivePayload) {
  owner.waiting = data.waiting;
  owner.waitingTotal = data.waitingTotal;
  owner.days = data.days;
}

function ensureOwner(campId: string, seed?: DeskLiveSeed): Owner {
  let owner = owners.get(campId);
  if (!owner) {
    owner = {
      campId,
      generation: 0,
      waiting: seed?.waiting ? [...seed.waiting] : [],
      waitingTotal: seed?.waitingTotal ?? seed?.waiting?.length ?? 0,
      days: seed?.days ? [...seed.days] : [],
      freshness: seed?.waiting || seed?.days ? "fresh" : "refreshing",
      pendingRemovals: new Set(),
      listeners: new Set(),
      abort: null,
      inFlight: false,
      timer: null,
      hasClientSnapshot: false,
    };
    owners.set(campId, owner);
  } else if (seed && !owner.hasClientSnapshot) {
    // Merge seeds from queue + seats before the first successful client fetch.
    if (seed.waiting && owner.waiting.length === 0) {
      owner.waiting = [...seed.waiting];
      owner.waitingTotal = seed.waitingTotal ?? seed.waiting.length;
    }
    if (seed.days && owner.days.length === 0) {
      owner.days = [...seed.days];
    }
    if (owner.waiting.length > 0 || owner.days.length > 0) {
      owner.freshness = "fresh";
    }
  }
  return owner;
}

function disposeIfEmpty(owner: Owner) {
  if (owner.listeners.size > 0) return;
  clearTimer(owner);
  owner.abort?.abort();
  owners.delete(owner.campId);
}

let visibilityBound = false;

function bindVisibility() {
  if (visibilityBound || typeof document === "undefined") return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      for (const owner of owners.values()) {
        clearTimer(owner);
      }
      return;
    }
    for (const owner of owners.values()) {
      if (owner.listeners.size === 0) continue;
      void runFetch(owner, { reason: "visibility" });
    }
  });
}

/**
 * Subscribe to the shared camp desk owner. Starts an immediate fetch and
 * ~20s visible-page polling. Returns unsubscribe.
 */
export function subscribeCampDeskLive(
  campId: string,
  listener: Listener,
  seed?: DeskLiveSeed,
): () => void {
  if (!campId) {
    listener(emptyView(null));
    return () => {};
  }
  bindVisibility();
  const owner = ensureOwner(campId, seed);
  owner.listeners.add(listener);
  listener(snapshot(owner));
  void runFetch(owner, { reason: "subscribe" });
  return () => {
    owner.listeners.delete(listener);
    disposeIfEmpty(owner);
  };
}

/** Manual refresh / Try Again — same path as poll, aborts in-flight. */
export function refreshCampDeskLive(campId: string) {
  const owner = owners.get(campId);
  if (!owner || owner.listeners.size === 0) return;
  void runFetch(owner, { reason: "manual" });
}

/** Optimistic remove by patient id; reconciled on next successful payload. */
export function markDeskLivePendingRemoval(campId: string, patientId: string) {
  const owner = owners.get(campId);
  if (!owner) return;
  owner.pendingRemovals.add(patientId);
  emit(owner);
}

export function clearDeskLivePendingRemoval(campId: string, patientId: string) {
  const owner = owners.get(campId);
  if (!owner) return;
  owner.pendingRemovals.delete(patientId);
  emit(owner);
}

/** Test helpers */
export function __resetCampDeskLiveForTests() {
  for (const owner of owners.values()) {
    clearTimer(owner);
    owner.abort?.abort();
  }
  owners.clear();
}

export function __campDeskLiveOwnerCountForTests() {
  return owners.size;
}

export function __campDeskLiveInFlightForTests(campId: string) {
  return Boolean(owners.get(campId)?.inFlight);
}
