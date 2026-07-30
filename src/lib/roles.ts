import type { UserRole } from "@/lib/types";

/**
 * Camp roles keep registration staff and the Clinical Desk separate.
 *
 * The doctor station was retired — the doctor writes on the printed
 * prescription and a volunteer or team lead scans it to mark the patient seen.
 * `is_staff()` and `is_camp_crew()` therefore describe the same set;
 * `isCampCrew` survives only as a name for "anyone who works a camp".
 */

/** Staff — admin, team lead, or volunteer. Matches SQL `is_staff()`. */
export function isStaff(role?: UserRole | string | null) {
  return role === "admin" || role === "team_lead" || role === "volunteer";
}

/**
 * Camp crew — every non-patient operational role at a camp.
 * Identical to {@link isStaff} now that doctors hold no login role.
 * Matches SQL `is_camp_crew()`.
 */
export function isClinicalOperator(role?: UserRole | string | null) {
  return role === "clinical_operator";
}

export function isCampCrew(role?: UserRole | string | null) {
  return isStaff(role);
}

export function isAdmin(role?: UserRole | string | null) {
  return role === "admin";
}

export function isTeamLead(role?: UserRole | string | null) {
  return role === "team_lead";
}

/** Who may register patients and print prescriptions (same set as Staff). */
export function canRegisterPatients(role?: UserRole | string | null) {
  return isStaff(role);
}

export function roleHome(role?: UserRole | string | null) {
  if (role === "admin") return "/admin";
  // A team lead works the same desk as a volunteer — scan, print, mark seen —
  // and /volunteer already adds their team panel on top. /team-lead is the
  // admin's roster view, not a lead's home.
  if (role === "team_lead") return "/volunteer";
  if (role === "volunteer") return "/volunteer";
  if (role === "clinical_operator") return "/clinical";
  // Patients do not authenticate (#59). Passwordless status is /s/<token>.
  return null;
}

/** True only for camp login roles; residual patient/doctor profiles are denied. */
export function isLoginRole(role?: UserRole | string | null): role is UserRole {
  return isCampCrew(role) || isClinicalOperator(role);
}
