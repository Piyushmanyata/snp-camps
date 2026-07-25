import { randomInt } from "node:crypto";

/**
 * Minimum password length enforced by Supabase Auth (project default).
 * Client and API must reject shorter values before the auth call.
 */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * Default length for the desk-slip passcode (Auth password for
 * reg{N}@patients.snp.local). Short enough to type from paper; no ambiguous glyphs.
 */
export const PATIENT_PASSCODE_LENGTH = 12;

export function isPasswordLongEnough(password: string) {
  return password.length >= MIN_PASSWORD_LENGTH;
}

/**
 * Crypto-random patient desk-slip passcode (also used as the Auth password).
 * Alphabet omits 0/O/1/I/L to reduce desk transcription errors.
 */
export function generatePatientPassword(
  length = PATIENT_PASSCODE_LENGTH,
): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let res = "";
  for (let i = 0; i < length; i++) res += chars.charAt(randomInt(chars.length));
  return res;
}

/** Alias for product language: desk slip "passcode" === Auth password. */
export const generatePatientPasscode = generatePatientPassword;

/** 14-char shareable temporary password for staff (no ambiguous glyphs). */
export function generateStaffPassword(length = 14): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet.charAt(randomInt(alphabet.length));
  return out;
}
