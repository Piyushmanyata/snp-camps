import { cache } from "react";
import { unstable_cache } from "next/cache";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { CampDayStats } from "@/lib/types";

export type ActiveCampSnapshot = {
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
  const supabase = createServiceRoleClient();
  if (!supabase) throw new Error("Camp service is not configured");

  const { data, error } = await supabase.rpc("active_camp_snapshot");
  if (error) throw new Error("Active camp data could not be loaded");
  return parseSnapshot(data);
}

const getCachedSnapshot = unstable_cache(
  fetchCachedSnapshot,
  ["active-camp-snapshot-v1"],
  { revalidate: 5 },
);

/** Public-only camp data; registration capacity is still enforced in Postgres. */
export const getActiveCampSnapshot = cache(async () => {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return getCachedSnapshot();
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("active_camp_snapshot");
  if (error) throw new Error("Active camp data could not be loaded");
  return parseSnapshot(data);
});

