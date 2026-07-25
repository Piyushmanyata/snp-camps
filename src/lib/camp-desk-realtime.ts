/**
 * Camp-scoped patient Realtime subscription for staff desks.
 * Pure module — inject a channel factory; no React, no Supabase import.
 */

/** Visible when the websocket is down and fixed poll is the safety net. */
export const RECONNECTING_INDICATOR =
  "Reconnecting — refreshing every 2 minutes";

export type CampDeskRealtimeStatus = "live" | "reconnecting";

export type CampDeskRealtimeCallbacks = {
  /** Apply a patient-row change or a reconnect catch-up. */
  onRefresh: () => void;
  onStatus: (status: CampDeskRealtimeStatus) => void;
};

/** Minimal Realtime channel surface (real client or test double). */
export type CampDeskChannel = {
  on: (
    type: "postgres_changes",
    filter: {
      event: string;
      schema: string;
      table: string;
      filter: string;
    },
    callback: (payload: unknown) => void,
  ) => CampDeskChannel;
  subscribe: (
    callback?: (status: string, err?: Error) => void,
  ) => CampDeskChannel;
};

export type CampDeskChannelFactory = {
  open: (topic: string) => CampDeskChannel;
  close: (channel: CampDeskChannel) => void | Promise<void>;
};

export function campDeskChannelTopic(campId: string): string {
  return `camp-desk:${campId}`;
}

let topicSeq = 0;

/** Unique Realtime topic so two desk widgets never share one channel instance. */
export function nextCampDeskChannelTopic(campId: string): string {
  topicSeq += 1;
  return `${campDeskChannelTopic(campId)}:${topicSeq}`;
}

/** Test-only reset for sequential topic ids. */
export function __resetCampDeskTopicSeqForTests() {
  topicSeq = 0;
}

/**
 * Subscribe to patient-row changes for one camp.
 * Returns teardown. Call again after camp change with a fresh campId
 * (callers must run the previous teardown first).
 */
export function subscribeCampDeskRealtime(
  campId: string,
  factory: CampDeskChannelFactory,
  callbacks: CampDeskRealtimeCallbacks,
): () => void {
  if (!campId) {
    return () => {};
  }

  let disposed = false;
  /** True after at least one successful SUBSCRIBED (reconnect catch-up gate). */
  let hadLive = false;
  // Unique topic per subscriber — LiveQueue + SeatBoard mount together, and
  // React Strict Mode remounts; reusing one topic throws after subscribe().
  const channel = factory.open(nextCampDeskChannelTopic(campId));

  const onChange = () => {
    if (disposed) return;
    callbacks.onRefresh();
  };

  channel
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "patients",
        filter: `camp_id=eq.${campId}`,
      },
      onChange,
    )
    .subscribe((status) => {
      if (disposed) return;
      if (status === "SUBSCRIBED") {
        if (hadLive) {
          // Gap while disconnected is invisible without an immediate catch-up.
          callbacks.onRefresh();
        }
        hadLive = true;
        callbacks.onStatus("live");
        return;
      }
      if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        callbacks.onStatus("reconnecting");
      }
    });

  return () => {
    disposed = true;
    void factory.close(channel);
  };
}
