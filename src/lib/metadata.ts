import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Camp } from "@/lib/types";

/** Request-scoped admin query so a router refresh always sees camp mutations. */
export const getCampsList = cache(async (): Promise<Camp[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("camps")
    .select(
      "id, name, venue, camp_date, is_active, created_at, spectacles_collection_date, spectacles_collection_venue, post_camp_surgery_date, post_camp_surgery_venue"
    )
    .order("created_at", { ascending: false });
  if (error) throw new Error("Camps data could not be loaded");
  return (data || []) as Camp[];
});
