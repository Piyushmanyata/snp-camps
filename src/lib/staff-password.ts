import { randomInt } from "node:crypto";

/** Keep this contract aligned with supabase/config.toml and Auth operations. */
export const MIN_PASSWORD_LENGTH = 12;
export const DEFAULT_STAFF_PASSWORD_LENGTH = 16;
export const PASSWORD_SYMBOLS = "!@#$%&*+-=?";

const LOWERCASE = "abcdefghjkmnpqrstuvwxyz";
const UPPERCASE = "ABCDEFGHJKMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const COMBINED = LOWERCASE + UPPERCASE + DIGITS + PASSWORD_SYMBOLS;

export function isStaffPasswordStrong(password: string): boolean {
  return (
    typeof password === "string" &&
    password.length >= MIN_PASSWORD_LENGTH &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[!@#$%&*+\-=\?]/.test(password)
  );
}

/** Generate a shareable temporary password with all four required classes. */
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
    PASSWORD_SYMBOLS[randomInt(PASSWORD_SYMBOLS.length)],
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
