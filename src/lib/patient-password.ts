/** Default initial password for all patient accounts. */
export const DEFAULT_PATIENT_PASSWORD = "1234";

/** Returns standard patient login password. Uses length parameter if provided or 12 by default. */
export function generatePatientPassword(length: number = 12): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let res = "";
  for (let i = 0; i < length; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}


