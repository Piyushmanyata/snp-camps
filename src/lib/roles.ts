import type { UserRole } from "@/lib/types";

/**
 * Staff — admin, team_lead, or volunteer.
 * Desk ops, registration, patient management. Matches SQL `is_staff()`.
 * Does NOT include doctor.
 */
export function isStaff(role?: UserRole | string | null) {
  return role === "admin" || role === "team_lead" || role === "volunteer";
}

/**
 * Camp crew — admin, team_lead, volunteer, or doctor.
 * Any non-patient operational role at a camp (QR scan handoff, desks).
 * Matches SQL `is_camp_crew()`.
 */
export function isCampCrew(role?: UserRole | string | null) {
  return role === "admin" || role === "team_lead" || role === "volunteer" || role === "doctor";
}

export function isAdmin(role?: UserRole | string | null) {
  return role === "admin";
}

export function isTeamLead(role?: UserRole | string | null) {
  return role === "team_lead";
}

export function isDoctor(role?: UserRole | string | null) {
  return role === "doctor";
}

/** Who may register patients at the desk (same set as Staff). */
export function canRegisterPatients(role?: UserRole | string | null) {
  return isStaff(role);
}

export function roleHome(role?: UserRole | string | null) {
  if (role === "admin") return "/admin";
  // A team lead works the same desk as a volunteer — register, check-in, scan,
  // queue — and /volunteer already adds their team panel on top. /team-lead is
  // the admin's roster view, not a lead's home.
  if (role === "team_lead") return "/volunteer";
  if (role === "volunteer") return "/volunteer";
  if (role === "doctor") return "/doctor";
  // Patients do not authenticate (#59). Passwordless status is /s/<token>.
  return null;
}

/** True only for staff/doctor login roles; residual patient profiles are denied. */
export function isLoginRole(role?: UserRole | string | null): role is UserRole {
  return role === "admin" || role === "team_lead" || role === "volunteer" || role === "doctor";
}
