import "server-only";
import { randomInt } from "node:crypto";
import { DEFAULT_STAFF_PASSWORD_LENGTH } from "@/lib/staff-password";

const LOWERCASE = "abcdefghjkmnpqrstuvwxyz";
const UPPERCASE = "ABCDEFGHJKMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%&*+-=?";
const COMBINED = LOWERCASE + UPPERCASE + DIGITS + SYMBOLS;

export function generateStaffPassword(
  length = DEFAULT_STAFF_PASSWORD_LENGTH,
): string {
  if (!Number.isInteger(length) || length < DEFAULT_STAFF_PASSWORD_LENGTH) {
    throw new RangeError(
      `Staff passwords must be at least ${DEFAULT_STAFF_PASSWORD_LENGTH} characters.`,
    );
  }

  const characters = [
    LOWERCASE[randomInt(LOWERCASE.length)],
    UPPERCASE[randomInt(UPPERCASE.length)],
    DIGITS[randomInt(DIGITS.length)],
    SYMBOLS[randomInt(SYMBOLS.length)],
  ];
  while (characters.length < length) {
    characters.push(COMBINED[randomInt(COMBINED.length)]);
  }

  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [characters[index], characters[swapIndex]] = [
      characters[swapIndex],
      characters[index],
    ];
  }
  return characters.join("");
}
