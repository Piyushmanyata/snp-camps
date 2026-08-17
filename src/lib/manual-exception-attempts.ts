export const MANUAL_EXCEPTION_ATTEMPT_THRESHOLD = 2;

export type FailedScanAttemptEvent = "failed-scan" | "new-registration";

export function nextFailedScanAttempts(
  count: number,
  event: FailedScanAttemptEvent,
): number {
  if (event === "new-registration") return 0;
  return count + 1;
}

export function manualExceptionUnlocked(count: number): boolean {
  return count >= MANUAL_EXCEPTION_ATTEMPT_THRESHOLD;
}
