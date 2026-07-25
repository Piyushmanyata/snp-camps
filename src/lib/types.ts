export type UserRole = "admin" | "volunteer" | "doctor" | "patient";
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

export function formatCampDay(isoDate: string) {
  try {
    return new Date(isoDate + "T12:00:00").toLocaleDateString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return isoDate;
  }
}
