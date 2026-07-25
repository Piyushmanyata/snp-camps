/**
 * One-tab handoff of a desk-issued patient passcode from registration/reissue
 * into the print page. sessionStorage only — never put passcodes in URLs.
 *
 * Cleared when staff dismisses the credential card or leaves the tab.
 */

const KEY_PREFIX = "snp-desk-passcode:";

function storageKey(patientId: string) {
  return KEY_PREFIX + patientId;
}

export function storeDeskPasscode(patientId: string, passcode: string) {
  if (typeof window === "undefined") return;
  const id = String(patientId || "").trim();
  const code = String(passcode || "").trim();
  if (!id || !code) return;
  try {
    window.sessionStorage.setItem(storageKey(id), code);
  } catch {
    /* private mode / quota — print sheet will omit passcode */
  }
}

export function readDeskPasscode(patientId: string): string | null {
  if (typeof window === "undefined") return null;
  const id = String(patientId || "").trim();
  if (!id) return null;
  try {
    const value = window.sessionStorage.getItem(storageKey(id));
    return value?.trim() || null;
  } catch {
    return null;
  }
}

export function clearDeskPasscode(patientId: string) {
  if (typeof window === "undefined") return;
  const id = String(patientId || "").trim();
  if (!id) return;
  try {
    window.sessionStorage.removeItem(storageKey(id));
  } catch {
    /* ignore */
  }
}
