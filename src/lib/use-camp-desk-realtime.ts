"use client";

import { useEffect, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import {
  subscribeCampDeskRealtime,
  type CampDeskChannel,
  type CampDeskChannelFactory,
  type CampDeskRealtimeStatus,
} from "@/lib/camp-desk-realtime";

export type DeskLiveStatus = CampDeskRealtimeStatus | "off";

function supabaseChannelFactory(
  supabase: SupabaseClient,
): CampDeskChannelFactory {
  return {
    open(topic) {
      return supabase.channel(topic) as unknown as CampDeskChannel;
    },
    async close(channel) {
      await supabase.removeChannel(channel as unknown as RealtimeChannel);
    },
  };
}

/**
 * Staff-desk hook: live patient changes for `campId`, or `off` when disabled.
 * Injects the browser Supabase client as the channel factory.
 */
export function useCampDeskRealtime(
  campId: string | null | undefined,
  onRefresh: () => void,
  enabled = true,
): DeskLiveStatus {
  const active = Boolean(enabled && campId);
  const [snapshot, setSnapshot] = useState<{
    campId: string;
    status: CampDeskRealtimeStatus;
  } | null>(null);

  useEffect(() => {
    if (!active || !campId) {
      return;
    }

    const supabase = createClient();
    const teardown = subscribeCampDeskRealtime(
      campId,
      supabaseChannelFactory(supabase),
      {
        onRefresh,
        onStatus: (status) => setSnapshot({ campId, status }),
      },
    );

    return () => {
      teardown();
    };
  }, [active, campId, onRefresh]);

  if (!active || !campId) return "off";
  // Connecting: no banner until Realtime reports reconnecting.
  if (!snapshot || snapshot.campId !== campId) return "live";
  return snapshot.status;
}
