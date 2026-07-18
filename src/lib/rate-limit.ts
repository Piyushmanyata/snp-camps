import "server-only";

import { createHash } from "node:crypto";

type Entry = {
  count: number;
  resetAt: number;
};

type Options = {
  scope: string;
  limit: number;
  windowMs: number;
  identifier?: string;
};

const globalStore = globalThis as typeof globalThis & {
  __snpRateLimits?: Map<string, Entry>;
  __snpRateLimitSweepAt?: number;
};

const store = globalStore.__snpRateLimits ?? new Map<string, Entry>();
globalStore.__snpRateLimits = store;

function clientAddress(request: Request) {
  return (
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "unknown"
  );
}

function sweepExpired(now: number) {
  if ((globalStore.__snpRateLimitSweepAt ?? 0) > now) return;
  globalStore.__snpRateLimitSweepAt = now + 60_000;

  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }

  // Bound memory even when an attacker rotates addresses.
  if (store.size > 20_000) {
    const targetSize = 15_000;
    for (const key of store.keys()) {
      store.delete(key);
      if (store.size <= targetSize) break;
    }
  }
}

/**
 * Per-instance burst protection. Production must also enforce a distributed
 * limit at the CDN/WAF because serverless instances do not share memory.
 */
export function checkRateLimit(request: Request, options: Options) {
  const now = Date.now();
  sweepExpired(now);

  const address = clientAddress(request);
  const addressHash = createHash("sha256")
    .update(address)
    .digest("base64url")
    .slice(0, 20);
  const key = options.scope + ":" + addressHash;
  const current = store.get(key);
  const entry =
    current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + options.windowMs };

  entry.count += 1;
  store.set(key, entry);

  const remaining = Math.max(0, options.limit - entry.count);
  const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  return {
    allowed: entry.count <= options.limit,
    headers: {
      "RateLimit-Limit": String(options.limit),
      "RateLimit-Remaining": String(remaining),
      "RateLimit-Reset": String(Math.ceil(entry.resetAt / 1000)),
      ...(entry.count > options.limit
        ? { "Retry-After": String(retryAfter) }
        : {}),
    },
  };
}
