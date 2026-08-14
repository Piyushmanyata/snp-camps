import { randomBytes } from "node:crypto";

export const STATUS_TOKEN_HEX_LENGTH = 32;

export function generateStatusToken(): string {
  return randomBytes(16).toString("hex");
}

export function isStatusTokenFormat(token: string): boolean {
  return /^[0-9a-f]{32}$/.test(token);
}
