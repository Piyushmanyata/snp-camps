import { cache } from "react";
import { unstable_cache } from "next/cache";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Camp, DoctorOption } from "@/lib/types";

/** User-facing copy when the doctor list cannot be loaded (config or query). */
export const DOCTOR_LIST_UNAVAILABLE =
  "Doctor list unavailable. Tell an admin.";

/** Request-scoped admin query so a router refresh always sees camp mutations. */
export const getCampsList = cache(async (): Promise<Camp[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("camps")
    .select("id, name, venue, camp_date, is_active, created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error("Camps data could not be loaded");
  return (data || []) as Camp[];
});

/** Single doctor-list query — service-role only; no session/RLS fallback. */
async function fetchDoctorsList(): Promise<DoctorOption[]> {
  const supabase = createServiceRoleClient();
  if (!supabase) throw new Error(DOCTOR_LIST_UNAVAILABLE);
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("role", "doctor")
    .is("disabled_at", null)
    .order("full_name", { ascending: true });
  if (error) throw new Error(DOCTOR_LIST_UNAVAILABLE);
  return (data || []) as DoctorOption[];
}

const getUnstableCachedDoctorsList = unstable_cache(
  fetchDoctorsList,
  ["doctors-list-metadata-v1"],
  { revalidate: 60, tags: ["doctors-list"] },
);

/**
 * Shared doctor metadata, invalidated by admin staff mutations (`doctors-list` tag).
 * Throws when the service-role key is missing or the query fails — never silent empty.
 */
export const getDoctorsList = cache(async (): Promise<DoctorOption[]> => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(DOCTOR_LIST_UNAVAILABLE);
  }
  return getUnstableCachedDoctorsList();
});
