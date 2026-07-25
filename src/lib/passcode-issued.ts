/**
 * Desk-slip Passcode issuance marker on the patient row.
 * Auth's password hash remains the only secret store (ADR 0001).
 */

/** Desk copy when passcode_issued_at is null — not "broken account". */
export const PASSCODE_NEVER_ISSUED_MARKER =
  "No passcode issued — reissue to enable reg-number login";

/** Null means never issued under the current scheme (legacy / OTP-only / unprovisioned). */
export function isPasscodeNeverIssued(
  passcodeIssuedAt: string | null | undefined,
): boolean {
  return passcodeIssuedAt == null;
}

/**
 * Column patch after a successful Auth password write (issue/reissue).
 * Returns null when the write failed — caller must not update the column.
 */
export function passcodeIssuedPatchOnAuthWrite(
  authWriteSucceeded: boolean,
  now: () => Date = () => new Date(),
): { passcode_issued_at: string } | null {
  if (!authWriteSucceeded) return null;
  return { passcode_issued_at: now().toISOString() };
}
