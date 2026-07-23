/** Aadhaar helpers — only last 4 digits are persisted on the patient row. */

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

export function digitsOnly(value: string): string {
  if (!value || typeof value !== "string" || value.length > 512) return "";
  return value.replace(/\D/g, "");
}

/** Format as XXXX XXXX XXXX while typing. */
export function formatAadhaarDisplay(raw: string): string {
  const d = digitsOnly(raw).slice(0, 12);
  const parts = [d.slice(0, 4), d.slice(4, 8), d.slice(8, 12)].filter(Boolean);
  return parts.join(" ");
}

export function aadhaarLast4(raw: string): string {
  const d = digitsOnly(raw);
  return d.length >= 4 ? d.slice(-4) : "";
}

/** Verhoeff checksum used by UIDAI for 12-digit Aadhaar. */
export function isValidAadhaarNumber(raw: string): boolean {
  const d = digitsOnly(raw);
  if (!/^\d{12}$/.test(d)) return false;
  // Reject obviously invalid (all same digit)
  if (/^(\d)\1{11}$/.test(d)) return false;

  let c = 0;
  const reversed = d.split("").reverse().map(Number);
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][reversed[i]]];
  }
  return c === 0;
}

/** Client-visible flag — set NEXT_PUBLIC_AADHAAR_LOOKUP_ENABLED=true when provider is ready. */
export function isAadhaarLookupEnabledClient(): boolean {
  return (
    process.env.NEXT_PUBLIC_AADHAAR_LOOKUP_ENABLED === "true" ||
    process.env.NEXT_PUBLIC_AADHAAR_LOOKUP_ENABLED === "1"
  );
}

/** Server: lookup works only when a provider URL is configured. */
export function isAadhaarLookupEnabledServer(): boolean {
  const url = process.env.AADHAAR_LOOKUP_URL?.trim();
  return Boolean(url);
}

export type AadhaarProfile = {
  full_name?: string | null;
  gender?: "M" | "F" | "O" | null;
  age?: number | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
};

export function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  if (age < 0 || age > 149) return null;
  return age;
}

export function normalizeGender(
  raw: string | null | undefined,
): "M" | "F" | "O" | null {
  if (!raw) return null;
  const g = raw.trim().toUpperCase();
  if (g === "M" || g === "MALE") return "M";
  if (g === "F" || g === "FEMALE") return "F";
  if (g === "O" || g === "OTHER" || g === "T") return "O";
  return null;
}
