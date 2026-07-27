/** Login roles only. Legacy DB enum may still list `patient`; app treats it as non-login. */
export type UserRole = "admin" | "volunteer" | "doctor";
export type QueueStatus = "registered" | "waiting" | "seen";

export type Profile = {
  id: string;
  role: UserRole;
  full_name: string | null;
  phone: string | null;
  email: string | null;
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
  paper_fallback_mode?: boolean;
};

/** Doctor picker option shared by desk RSC loaders and client scanners. */
export type DoctorOption = {
  id: string;
  full_name: string | null;
};

export type CampDayStats = {
  id: string;
  camp_id: string;
  day_date: string;
  seat_limit: number;
  seats_taken: number;
  seats_left: number;
  is_full: boolean;
  theatre_capacity?: number;
  theatre_reserved?: number;
  theatre_remaining?: number;
};

export function queueLabel(status: string) {
  if (status === "seen") return "Doctor seen";
  if (status === "waiting") return "In queue";
  return "Registered";
}

export function queueTone(status: string): "default" | "ok" | "wait" {
  if (status === "seen") return "ok";
  if (status === "waiting") return "wait";
  return "default";
}

export { formatCampDay } from "./format-camp-day";
