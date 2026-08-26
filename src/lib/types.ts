export type UserRole =
  | "admin"
  | "team_lead"
  | "volunteer"
  | "clinical_operator";
export type QueueStatus = "registered" | "seen";

export type Profile = {
  id: string;
  role: UserRole;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  team_lead_id?: string | null;
  disabled_at?: string | null;
};

export type Camp = {
  id: string;
  name: string;
  venue: string | null;
  camp_date: string | null;
  is_active: boolean;
  created_at: string;
  spectacles_collection_date?: string | null;
  spectacles_collection_venue?: string | null;
  post_camp_surgery_date?: string | null;
  post_camp_surgery_venue?: string | null;
};

export type CampDayStats = {
  id: string;
  camp_id: string;
  day_date: string;
  seat_limit: number;
  seats_taken: number;
  seats_left: number;
  is_full: boolean;
  printing_open?: boolean;
};

export function queueLabel(status: string) {
  if (status === "seen") return "Seen";
  return "Registered";
}

/** Field surfaces read Simple English — never render the raw M/F/O column. */
export function genderLabel(gender: string | null | undefined) {
  if (gender === "M") return "Male";
  if (gender === "F") return "Female";
  if (gender === "O") return "Other";
  return "—";
}

export function queueTone(status: string): "default" | "ok" {
  if (status === "seen") return "ok";
  return "default";
}

export { formatCampDay } from "./format-camp-day";
