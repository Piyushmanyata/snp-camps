/**
 * Person duplicate key (#109 prefactor).
 *
 * Pure derivation only — nothing in the app calls this yet. Later tickets
 * wire it into registration / self-registration.
 *
 * Key material matches CONTEXT.md:
 *   HMAC-SHA256(last4 + normalised_name + dob + gender)
 * using the existing Aadhaar pepper env vars.
 */

import { createHmac } from "node:crypto";
import { parseDateOfBirth } from "@/lib/aadhaar-text";

/**
 * The Aadhaar pepper. Survives the eKYC deletion (#116) because the Person
 * duplicate key is keyed on it; only the eKYC *provider* config was retired.
 */
export function getAadhaarPepper(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return (
    env.AADHAAR_HASH_PEPPER?.trim() ||
    env.AADHAAR_KYC_PEPPER?.trim() ||
    env.AADHAAR_PEPPER?.trim() ||
    null
  );
}

/** Same rule as `patients.full_name_normalized`: case-fold + collapse whitespace. */
export function normalizePersonName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export type PersonDuplicateKeyInput = {
  /** Aadhaar last-4 only — never the full 12-digit number. */
  aadhaarLast4: string;
  /**
   * Verbatim scanned name from the card. Do not pass a display-name
   * transliteration — the key must ignore volunteer typing choices.
   */
  name: string;
  /** Full DOB (`YYYY-MM-DD` preferred; other common shapes are normalised). */
  dateOfBirth: string;
  /** Prefer M / F / O as produced by {@link normalizeGender}. */
  gender: string;
};

/**
 * Build the stable HMAC for a scanned card identity.
 * Throws when the pepper is missing so we never mint a weak key.
 */
export function derivePersonDuplicateKey(
  input: PersonDuplicateKeyInput,
  env: Record<string, string | undefined> = process.env,
): string {
  const pepper = getAadhaarPepper(env);
  if (!pepper) {
    throw new Error(
      "AADHAAR_HASH_PEPPER (or AADHAAR_KYC_PEPPER) is required to derive a Person key.",
    );
  }

  const last4 = input.aadhaarLast4.replace(/\D/g, "").slice(-4);
  if (last4.length !== 4) {
    throw new Error("Person key requires a 4-digit Aadhaar last-4.");
  }

  const dob =
    parseDateOfBirth(input.dateOfBirth) || input.dateOfBirth.trim();
  if (!dob) {
    throw new Error("Person key requires a date of birth.");
  }

  const gender = input.gender.trim().toUpperCase();
  if (!gender) {
    throw new Error("Person key requires a gender.");
  }

  const material =
    last4 + normalizePersonName(input.name) + dob + gender;

  return createHmac("sha256", pepper).update(material, "utf8").digest("hex");
}
