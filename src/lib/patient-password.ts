import { randomBytes } from "crypto";

/**
 * Human-friendly camp password: 8 chars, no ambiguous glyphs.
 * Shown once + sent via SMS/WhatsApp when configured.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePatientPassword(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}
