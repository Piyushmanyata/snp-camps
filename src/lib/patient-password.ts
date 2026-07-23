import { randomInt } from "node:crypto";

/** Synthetic auth email for reg-no + password patient accounts. */
export function patientAuthEmail(regNo: number | string) {
  return `reg${regNo}@patients.snp.local`;
}

/** Default initial password for all patient accounts. Must satisfy Supabase Auth min 6-char policy. */
export const DEFAULT_PATIENT_PASSWORD = "123456";

/** Returns a crypto-random patient login password (default 12 chars). */
export function generatePatientPassword(length = 12): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let res = "";
  for (let i = 0; i < length; i++) res += chars.charAt(randomInt(chars.length));
  return res;
}

/** 14-char shareable temporary password for staff (no ambiguous glyphs). */
export function generateStaffPassword(length = 14): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet.charAt(randomInt(alphabet.length));
  return out;
}
