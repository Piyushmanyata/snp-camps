/**
 * Synthetic auth email for reg-no + desk-slip passcode patient accounts.
 * Passcode is the Auth password; never store plaintext passcodes server-side
 * beyond one-time staff responses after authentication.
 */
export function patientAuthEmail(regNo: number | string) {
  return `reg${regNo}@patients.snp.local`;
}
