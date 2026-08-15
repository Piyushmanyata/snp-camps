export const MIN_PASSWORD_LENGTH = 12;
export const DEFAULT_STAFF_PASSWORD_LENGTH = 16;

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
