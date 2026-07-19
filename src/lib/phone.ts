/** Normalize the Indian mobile formats accepted by registration and OTP flows. */
export function normalizePhoneE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const mobile = (value: string) => /^[6-9]\d{9}$/.test(value);

  if (digits.length === 10 && mobile(digits)) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0") && mobile(digits.slice(1))) {
    return `+91${digits.slice(1)}`;
  }
  if (digits.length === 12 && digits.startsWith("91") && mobile(digits.slice(2))) {
    return `+${digits}`;
  }
  if (digits.length === 13 && digits.startsWith("091") && mobile(digits.slice(3))) {
    return `+91${digits.slice(3)}`;
  }
  return null;
}
