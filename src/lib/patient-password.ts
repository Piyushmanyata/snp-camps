import { randomInt } from "node:crypto";

/**
 * Minimum password length enforced by Supabase Auth (project default).
 * Client and API must reject shorter values before the auth call.
 */
export const MIN_PASSWORD_LENGTH = 6;

export function isPasswordLongEnough(password: string) {
  return password.length >= MIN_PASSWORD_LENGTH;
}

/** 14-char shareable temporary password for staff (no ambiguous glyphs). */
export function generateStaffPassword(length = 14): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet.charAt(randomInt(alphabet.length));
  return out;
}
