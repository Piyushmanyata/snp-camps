/** Default initial password for all patient accounts. */
export const DEFAULT_PATIENT_PASSWORD = "1234";

/** Returns standard default patient login password "1234". */
export function generatePatientPassword(_length?: number): string {
  return DEFAULT_PATIENT_PASSWORD;
}
