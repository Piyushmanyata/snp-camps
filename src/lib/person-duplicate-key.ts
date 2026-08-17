
import { createHmac } from "node:crypto";
import { parseDateOfBirth } from "@/lib/aadhaar-text";

export function getAadhaarPepper(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.AADHAAR_HASH_PEPPER?.trim() || null;
}

// No Unicode normalisation here: NFC decomposes the precomposed nukta letters
// U+0958..U+095F (composition exclusions), which are routine in Hindi and Urdu
// names, so adding it silently rekeys every stored Person that has one. Unifying
// the spellings needs a backfill, not a one-line change.
export function normalizePersonName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export type PersonDuplicateKeyInput = {
  aadhaarLast4: string;
  name: string;
  dateOfBirth: string;
  gender: string;
};

export function derivePersonDuplicateKey(
  input: PersonDuplicateKeyInput,
  env: Record<string, string | undefined> = process.env,
): string {
  const pepper = getAadhaarPepper(env);
  if (!pepper) {
    throw new Error(
      "AADHAAR_HASH_PEPPER is required to derive a Person key.",
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
