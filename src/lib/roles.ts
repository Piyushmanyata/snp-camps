import type { UserRole } from "@/lib/types";

export function isStaff(role?: UserRole | string | null) {
  return role === "admin" || role === "team_lead" || role === "volunteer";
}

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

export function canRegisterPatients(role?: UserRole | string | null) {
  return isStaff(role);
}

export function roleHome(role?: UserRole | string | null) {
  if (role === "admin") return "/admin";
  if (role === "team_lead") return "/volunteer";
  if (role === "volunteer") return "/volunteer";
  if (role === "clinical_operator") return "/clinical";
  // Patients do not authenticate (#59). Passwordless status is /s/<token>.
  return null;
}

export function isLoginRole(role?: UserRole | string | null): role is UserRole {
  return isCampCrew(role) || isClinicalOperator(role);
}
