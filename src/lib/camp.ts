import { cache } from "react";
import { cacheLife, cacheTag } from "next/cache";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { CampDayStats } from "@/lib/types";

type ActiveCampSnapshot = {
  id: string;
  name: string;
  venue: string | null;
  camp_date: string | null;
  days: CampDayStats[];
};

function parseSnapshot(data: unknown): ActiveCampSnapshot | null {
  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | null
    | undefined;
  if (!row || typeof row.id !== "string" || typeof row.name !== "string") {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    venue: typeof row.venue === "string" ? row.venue : null,
    camp_date: typeof row.camp_date === "string" ? row.camp_date : null,
    days: Array.isArray(row.days) ? (row.days as CampDayStats[]) : [],
  };
}

async function fetchCachedSnapshot() {
  "use cache";
  cacheTag("active-camp-snapshot");
  cacheLife({ revalidate: 5 });

  const supabase = createServiceRoleClient();
  if (!supabase) {
    console.error("[camp] active camp snapshot failed", {
      code: undefined,
      message: "Camp service is not configured",
    });
    return null;
  }

  const { data, error } = await supabase.rpc("active_camp_snapshot");
  if (error) {
    console.error("[camp] active camp snapshot failed", {
      code: error?.code,
      message: error?.message,
    });
    return null;
  }
  return parseSnapshot(data);
}

async function fetchSnapshot() {
  const supabase = createServiceRoleClient() ?? (await createClient());

  const { data, error } = await supabase.rpc("active_camp_snapshot");
  if (error) {
    console.error("[camp] active camp snapshot failed", {
      code: error?.code,
      message: error?.message,
    });
    return null;
  }
  return parseSnapshot(data);
}

export const getActiveCampSnapshot = cache(async () => {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return fetchCachedSnapshot();
  }

  return fetchSnapshot();
});

export const getActiveCampSnapshotFresh = cache(fetchSnapshot);
