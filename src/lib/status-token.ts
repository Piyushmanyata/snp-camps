import { randomBytes } from "node:crypto";

/** ≥128 bits of entropy, URL-safe hex (32 chars). Not derived from UUID or reg no. */
export const STATUS_TOKEN_HEX_LENGTH = 32;

export function generateStatusToken(): string {
  return randomBytes(16).toString("hex");
}

export function isStatusTokenFormat(token: string): boolean {
  return /^[0-9a-f]{32}$/.test(token);
}
