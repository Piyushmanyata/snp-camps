import type { UserRole } from "@/lib/types";

/**
 * Staff — admin or volunteer.
 * Desk ops, registration, patient management. Matches SQL `is_staff()`.
 * Does NOT include doctor.
 */
export function isStaff(role?: UserRole | null) {
  return role === "admin" || role === "volunteer";
}

/**
 * Camp crew — admin, volunteer, or doctor.
 * Any non-patient operational role at a camp (QR scan handoff, desks).
 * Matches SQL `is_camp_crew()`.
 */
export function isCampCrew(role?: UserRole | null) {
  return role === "admin" || role === "volunteer" || role === "doctor";
}

export function isAdmin(role?: UserRole | null) {
  return role === "admin";
}

export function isDoctor(role?: UserRole | null) {
  return role === "doctor";
}

/** Who may register patients at the desk (same set as Staff). */
export function canRegisterPatients(role?: UserRole | null) {
  return isStaff(role);
}

export function roleHome(role?: UserRole | null) {
  if (role === "admin") return "/admin";
  if (role === "volunteer") return "/volunteer";
  if (role === "doctor") return "/doctor";
  // Patients have no app home — passwordless status is /s/<token> (no session).
  if (role === "patient") return null;
  return null;
}
