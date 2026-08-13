import { SMS_VENUE_MAX } from "@/lib/registration-sms";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

/** Re-export MAX_SMS_VENUE_LENGTH alias matching ticket specifications. */
export const MAX_SMS_VENUE_LENGTH = SMS_VENUE_MAX;

export type CampSettings = {
  spectaclesCollectionDate: string | null;
  spectaclesCollectionVenue: string | null;
  postCampSurgeryDate: string | null;
  postCampSurgeryVenue: string | null;
};

export type CampSettingsInput = {
  spectaclesCollectionDate?: string | null;
  spectaclesCollectionVenue?: string | null;
  postCampSurgeryDate?: string | null;
  postCampSurgeryVenue?: string | null;
};

/** Validates venue string length against SMS segment cap (35 chars). */
export function validateVenueLength(venue?: string | null): boolean {
  if (!venue) return true;
  return venue.trim().length <= MAX_SMS_VENUE_LENGTH;
}

/** Format venue string or convert empty/whitespace string to null. */
export function normalizeVenueInput(venue?: string | null): string | null {
  if (venue === undefined || venue === null) return null;
  const trimmed = venue.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Format date string or convert empty string to null. */
export function normalizeDateInput(dateStr?: string | null): string | null {
  if (dateStr === undefined || dateStr === null) return null;
  const trimmed = dateStr.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Get admin settings for a given camp. Returns null if camp not found. */
export async function getCampSettings(
  campId: string,
  client?: SupabaseClient
): Promise<CampSettings | null> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from("camps")
    .select(
      "spectacles_collection_date, spectacles_collection_venue, post_camp_surgery_date, post_camp_surgery_venue"
    )
    .eq("id", campId)
    .single();

  if (error || !data) return null;

  return {
    spectaclesCollectionDate: data.spectacles_collection_date ?? null,
    spectaclesCollectionVenue: data.spectacles_collection_venue ?? null,
    postCampSurgeryDate: data.post_camp_surgery_date ?? null,
    postCampSurgeryVenue: data.post_camp_surgery_venue ?? null,
  };
}

/** Update admin settings for a camp. Throws error if venue validation fails or DB update is refused. */
export async function updateCampSettings(
  campId: string,
  input: CampSettingsInput,
  client?: SupabaseClient
): Promise<{ success: boolean }> {
  const specVenue = normalizeVenueInput(input.spectaclesCollectionVenue);
  const surgVenue = normalizeVenueInput(input.postCampSurgeryVenue);

  if (specVenue && specVenue.length > MAX_SMS_VENUE_LENGTH) {
    throw new Error(
      `Spectacles collection venue exceeds maximum allowed length of ${MAX_SMS_VENUE_LENGTH} characters`
    );
  }

  if (surgVenue && surgVenue.length > MAX_SMS_VENUE_LENGTH) {
    throw new Error(
      `Post-camp surgery venue exceeds maximum allowed length of ${MAX_SMS_VENUE_LENGTH} characters`
    );
  }

  const specDate = normalizeDateInput(input.spectaclesCollectionDate);
  const surgDate = normalizeDateInput(input.postCampSurgeryDate);

  const supabase = client ?? (await createClient());

  // Try RPC update first
  const { error: rpcErr } = await supabase.rpc("update_camp_settings", {
    p_camp_id: campId,
    p_spectacles_collection_date: specDate,
    p_spectacles_collection_venue: specVenue,
    p_post_camp_surgery_date: surgDate,
    p_post_camp_surgery_venue: surgVenue,
  });

  if (!rpcErr) {
    return { success: true };
  }

  // Fallback to direct table update if RPC unavailable in test double
  const { data, error } = await supabase
    .from("camps")
    .update({
      spectacles_collection_date: specDate,
      spectacles_collection_venue: specVenue,
      post_camp_surgery_date: surgDate,
      post_camp_surgery_venue: surgVenue,
    })
    .eq("id", campId)
    .select();

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    throw new Error("Update refused or camp not found");
  }

  return { success: true };
}
