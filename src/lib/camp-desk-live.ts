/**
 * Camp-keyed desk snapshot owner (#56, #63).
 * One shared poller per campId for the seat board.
 * Pure module — no React; polling only.
 *
 * Freshness:
 * - fresh: last fetch succeeded
 * - refreshing: in-flight
 * - stale-error: prior known rows kept; soft refresh failed
 * - error: no known snapshot; not an empty success
 * - off: no camp
 */

import { fetchDeskLive, type DeskLivePayload } from "@/lib/desk-live";
import { POLL_MS } from "@/lib/poll";
import type { CampDayStats } from "@/lib/types";

export type DeskLiveFreshness =
  | "fresh"
  | "refreshing"
  | "stale-error"
  | "error"
  | "off";

export type DeskLiveView = {
  campId: string | null;
  days: CampDayStats[];
  freshness: DeskLiveFreshness;
  /** True after SSR seed success or a successful client payload for days. */
  daysKnown: boolean;
  /** Monotonic generation; only the latest non-aborted apply wins. */
  generation: number;
};

export type DeskLiveSeed = {
  days?: CampDayStats[];
  /** SSR succeeded for days (including empty). */
  daysKnown?: boolean;
};

type Listener = (view: DeskLiveView) => void;

type Owner = {
  campId: string;
  generation: number;
  days: CampDayStats[];
  freshness: DeskLiveFreshness;
  daysKnown: boolean;
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
    days: [],
    freshness: campId ? "refreshing" : "off",
    daysKnown: false,
    generation: 0,
  };
}

function snapshot(owner: Owner): DeskLiveView {
  return {
    campId: owner.campId,
    days: owner.days,
    freshness: owner.freshness,
    daysKnown: owner.daysKnown,
    generation: owner.generation,
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

function failureFreshness(owner: Owner): DeskLiveFreshness {
  // Any prior known snapshot → soft failure preserves content.
  if (owner.hasClientSnapshot || owner.daysKnown) {
    return "stale-error";
  }
  return "error";
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
    owner.daysKnown = true;
    emit(owner);
  } catch {
    if (abort.signal.aborted || generation !== owner.generation) return;
    // Preserve already-loaded rows; mark stale or hard error (#63).
    owner.freshness = failureFreshness(owner);
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
  owner.days = data.days;
}

function seedDaysKnown(seed?: DeskLiveSeed): boolean {
  if (!seed) return false;
  return (
    seed.daysKnown === true ||
    (seed.daysKnown !== false && Array.isArray(seed.days))
  );
}

function ensureOwner(campId: string, seed?: DeskLiveSeed): Owner {
  let owner = owners.get(campId);
  if (!owner) {
    const daysKnown = seedDaysKnown(seed);
    owner = {
      campId,
      generation: 0,
      days: seed?.days ? [...seed.days] : [],
      freshness: daysKnown ? "fresh" : "refreshing",
      daysKnown,
      listeners: new Set(),
      abort: null,
      inFlight: false,
      timer: null,
      hasClientSnapshot: false,
    };
    owners.set(campId, owner);
  } else if (seed && !owner.hasClientSnapshot) {
    if (seed.days && owner.days.length === 0) {
      owner.days = [...seed.days];
    }
    if (seedDaysKnown(seed)) {
      owner.daysKnown = true;
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
