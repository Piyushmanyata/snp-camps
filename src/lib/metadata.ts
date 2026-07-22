import { cache } from "react";
import { unstable_cache } from "next/cache";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Camp } from "@/lib/types";
import type { DoctorOption } from "@/components/qr-scanner";

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

async function fetchCachedDoctorsList(): Promise<DoctorOption[]> {
  const supabase = createServiceRoleClient();
  if (!supabase) throw new Error("Doctor service is not configured");
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("role", "doctor")
    .is("disabled_at", null)
    .order("full_name", { ascending: true });
  if (error) throw new Error("Doctor list could not be loaded");
  return (data || []) as DoctorOption[];
}

const getUnstableCachedDoctorsList = unstable_cache(
  fetchCachedDoctorsList,
  ["doctors-list-metadata-v1"],
  { revalidate: 60, tags: ["doctors-list"] },
);

/** Shared doctor metadata, invalidated by the admin doctor API. */
export const getDoctorsList = cache(async (): Promise<DoctorOption[]> => {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return getUnstableCachedDoctorsList();
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("role", "doctor")
    .is("disabled_at", null)
    .order("full_name", { ascending: true });
  if (error) throw new Error("Doctor list could not be loaded");
  return (data || []) as DoctorOption[];
});
