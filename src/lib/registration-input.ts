import { kolkataTodayIso } from "@/lib/patient-form-validate";
import { validateHouseholdPhone } from "@/lib/phone";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RegistrationValidation =
  | { ok: true }
  | { ok: false; message: string };

export function isRegistrationUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export function isIsoCalendarDate(
  value: unknown,
  now: Date = new Date(),
): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return false;
  }
  return value <= kolkataTodayIso(now);
}

export function derivedAgeYears(
  dateOfBirth: string,
  now: Date = new Date(),
): number {
  const today = kolkataTodayIso(now);
  const [ty, tm, td] = today.split("-").map(Number);
  const [by, bm, bd] = dateOfBirth.split("-").map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

export function validateRegistrationIds(input: {
  requestId: unknown;
  campId: unknown;
  campDayId: unknown;
}): RegistrationValidation {
  if (!isRegistrationUuid(input.requestId)) {
    return { ok: false, message: "A valid registration request ID is required." };
  }
  if (!isRegistrationUuid(input.campId) || !isRegistrationUuid(input.campDayId)) {
    return { ok: false, message: "A valid camp and camp day are required." };
  }
  return { ok: true };
}

export function validateRegistrationIdentity(input: {
  fullName: unknown;
  displayName?: unknown;
  address?: unknown;
  gender: unknown;
  age: unknown;
  email?: unknown;
  dateOfBirth?: unknown;
  selfService: boolean;
  now?: Date;
}): RegistrationValidation {
  const fullName = typeof input.fullName === "string" ? input.fullName.trim() : "";
  const displayName =
    typeof input.displayName === "string" ? input.displayName.trim() : "";
  const address = typeof input.address === "string" ? input.address.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const gender = typeof input.gender === "string" ? input.gender.trim().toUpperCase() : "";

  if (!fullName || [...fullName].length > 80) {
    return { ok: false, message: "Full name must be between 1 and 80 characters." };
  }
  if (displayName && [...displayName].length > 80) {
    return { ok: false, message: "Display name must be at most 80 characters." };
  }
  if ([...address].length > 120) {
    return { ok: false, message: "Address must be at most 120 characters." };
  }
  if (input.selfService ? !["M", "F", "O"].includes(gender) : gender && !["M", "F", "O"].includes(gender)) {
    return { ok: false, message: "Gender must be M, F, or O." };
  }
  if (!Number.isInteger(input.age) || Number(input.age) < 0 || Number(input.age) > 149) {
    return { ok: false, message: "Age must be between 0 and 149." };
  }
  if (email && ([...email].length > 254 || !EMAIL_RE.test(email))) {
    return { ok: false, message: "Enter a valid email address." };
  }
  if (input.dateOfBirth !== undefined) {
    if (!isIsoCalendarDate(input.dateOfBirth, input.now)) {
      return { ok: false, message: "Date of birth must be a real, non-future date." };
    }
    if (derivedAgeYears(input.dateOfBirth, input.now) !== Number(input.age)) {
      return { ok: false, message: "Age must match date of birth." };
    }
  }
  return { ok: true };
}

export function validateRegistrationPhone(value: unknown) {
  return validateHouseholdPhone(typeof value === "string" ? value.trim() : "");
}

export function validateAadhaarLast4(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}$/.test(value.trim());
}
