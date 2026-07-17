/** Synthetic auth email for reg-no + password patient accounts. */
export function patientAuthEmail(regNo: number | string) {
  return `reg${regNo}@patients.snp.local`;
}
