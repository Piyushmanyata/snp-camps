import "server-only";

import { createHmac, randomBytes } from "node:crypto";
import type { AadhaarProfile } from "@/lib/aadhaar";

export const AADHAAR_KYC_SESSION_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 10_000;

type PendingSession = {
  status: "pending" | "verifying";
  txnId: string;
  aadhaarHash: string;
  aadhaarLast4: string;
  expiresAt: number;
};

type VerifiedSession = {
  status: "verified";
  aadhaarHash: string;
  aadhaarLast4: string;
  expiresAt: number;
  profile: AadhaarProfile;
  providerRef: string;
  phone: string | null;
};

type TerminalSession = {
  status: "expired" | "rejected";
  expiresAt: number;
};

type StoredSession = PendingSession | VerifiedSession | TerminalSession;

export type AadhaarKycSessionOutcome =
  | { status: "missing" }
  | { status: "expired" }
  | { status: "rejected" }
  | { status: "verifying" }
  | { status: "verified" }
  | { status: "pending"; txnId: string };

export type ConsumedAadhaarKycSession = {
  aadhaarHash: string;
  aadhaarLast4: string;
  profile: AadhaarProfile;
  providerRef: string;
  phone: string | null;
};

const globalStore = globalThis as typeof globalThis & {
  __snpAadhaarKycSessions?: Map<string, StoredSession>;
};

const sessions =
  globalStore.__snpAadhaarKycSessions ?? new Map<string, StoredSession>();
globalStore.__snpAadhaarKycSessions = sessions;

function prune(now: number) {
  // ponytail: process-local storage is the smallest option for this ticket;
  // move the session map to shared storage when a multi-instance flow needs it.
  for (const [handle, session] of sessions) {
    if (session.expiresAt + 60_000 <= now) sessions.delete(handle);
  }
}

function activeSession(handle: string, now: number): StoredSession | null {
  const session = sessions.get(handle);
  if (!session) return null;
  if (session.expiresAt <= now) {
    if (session.status !== "expired") {
      sessions.set(handle, { status: "expired", expiresAt: session.expiresAt });
    }
    return sessions.get(handle) ?? null;
  }
  return session;
}

function isHandle(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,64}$/.test(value);
}

export function getAadhaarKycPepper(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const pepper =
    env.AADHAAR_HASH_PEPPER?.trim() ||
    env.AADHAAR_KYC_PEPPER?.trim() ||
    env.AADHAAR_PEPPER?.trim();
  return pepper || null;
}

export function hashAadhaar(aadhaarDigits: string, pepper: string): string {
  return createHmac("sha256", pepper).update(aadhaarDigits).digest("hex");
}

export function createAadhaarKycSession(input: {
  txnId: string;
  aadhaarDigits: string;
  pepper: string;
  now?: number;
}): { handle: string; expiresAt: number } {
  const now = input.now ?? Date.now();
  prune(now);
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (typeof oldest === "string") sessions.delete(oldest);
  }
  const handle = randomBytes(32).toString("base64url");
  const expiresAt = now + AADHAAR_KYC_SESSION_TTL_MS;
  sessions.set(handle, {
    status: "pending",
    txnId: input.txnId,
    aadhaarHash: hashAadhaar(input.aadhaarDigits, input.pepper),
    aadhaarLast4: input.aadhaarDigits.slice(-4),
    expiresAt,
  });
  return { handle, expiresAt };
}

export function beginAadhaarKycVerification(
  handle: string,
  now = Date.now(),
): AadhaarKycSessionOutcome {
  prune(now);
  if (!isHandle(handle)) return { status: "missing" };
  const session = activeSession(handle, now);
  if (!session) return { status: "missing" };
  if (session.status === "pending") {
    sessions.set(handle, { ...session, status: "verifying" });
    return { status: "pending", txnId: session.txnId };
  }
  return { status: session.status };
}

export function releaseAadhaarKycVerification(handle: string): boolean {
  const session = sessions.get(handle);
  if (!session || session.status !== "verifying") return false;
  sessions.set(handle, { ...session, status: "pending" });
  return true;
}

export function finishAadhaarKycVerification(input: {
  handle: string;
  profile: AadhaarProfile;
  providerRef: string;
  phone: string | null;
}): boolean {
  const session = sessions.get(input.handle);
  if (!session || session.status !== "verifying") return false;
  sessions.set(input.handle, {
    status: "verified",
    aadhaarHash: session.aadhaarHash,
    aadhaarLast4: session.aadhaarLast4,
    expiresAt: session.expiresAt,
    profile: input.profile,
    providerRef: input.providerRef,
    phone: input.phone,
  });
  return true;
}

export function finishAadhaarKycFailure(
  handle: string,
  failureKind: "rejected" | "expired" | "uncertain",
): boolean {
  const session = sessions.get(handle);
  if (!session || session.status !== "verifying") return false;
  if (failureKind === "uncertain") {
    sessions.set(handle, { ...session, status: "pending" });
  } else {
    sessions.set(handle, {
      status: failureKind,
      expiresAt: session.expiresAt,
    });
  }
  return true;
}

export function consumeVerifiedAadhaarKycSession(
  handle: string,
  now = Date.now(),
): ConsumedAadhaarKycSession | null {
  prune(now);
  if (!isHandle(handle)) return null;
  const session = activeSession(handle, now);
  if (!session || session.status !== "verified") return null;
  sessions.delete(handle);
  return {
    aadhaarHash: session.aadhaarHash,
    aadhaarLast4: session.aadhaarLast4,
    profile: session.profile,
    providerRef: session.providerRef,
    phone: session.phone,
  };
}

export function peekVerifiedAadhaarKycSession(handle: string, now = Date.now()): ConsumedAadhaarKycSession | null {
  prune(now);
  if (!isHandle(handle)) return null;
  const session = activeSession(handle, now);
  if (!session || session.status !== "verified") return null;
  return {
    aadhaarHash: session.aadhaarHash,
    aadhaarLast4: session.aadhaarLast4,
    profile: session.profile,
    providerRef: session.providerRef,
    phone: session.phone,
  };
}

export function resetAadhaarKycSessionsForTests() {
  sessions.clear();
}
