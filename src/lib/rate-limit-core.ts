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
  if (store.size > 20_000) {
    const targetSize = 15_000;
    for (const key of store.keys()) {
      store.delete(key);
      if (store.size <= targetSize) break;
    }
  }

  if ((globalStore.__snpRateLimitSweepAt ?? 0) > now) return;
  globalStore.__snpRateLimitSweepAt = now + 60_000;

  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

function hashValue(value: string) {
  return createHash("sha256")
    .update(value)
    .digest("base64url")
    .slice(0, 20);
}

export function rateLimitIdentifiers(request: Request, identifier?: string) {
  const keys = [`ip:${hashValue(clientAddress(request))}`];
  const subject = identifier?.trim();
  if (subject) keys.push(`subject:${hashValue(subject)}`);
  return keys;
}

function recordLimit(
  key: string,
  windowMs: number,
  now: number,
) {
  const current = store.get(key);
  const entry =
    current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + windowMs };

  entry.count += 1;
  store.set(key, entry);
  return entry;
}

/**
 * Per-instance burst protection. Production must also enforce a distributed
 * limit at the CDN/WAF because serverless instances do not share memory.
 */
export function checkRateLimit(request: Request, options: Options) {
  const now = Date.now();
  sweepExpired(now);

  const keys = rateLimitIdentifiers(request, options.identifier).map(
    (key) => `${options.scope}:${key}`,
  );

  // Keep both protections: an attacker cannot rotate identifiers from one IP,
  // and one patient/token cannot bypass the limit by rotating IPs.
  const entries = keys.map((key) =>
    recordLimit(key, options.windowMs, now),
  );
  const entry = entries.reduce(
    (current, candidate) =>
      candidate.count > current.count ||
      (candidate.count === current.count && candidate.resetAt > current.resetAt)
        ? candidate
        : current,
    entries[0],
  );
  const remaining = Math.min(
    ...entries.map((item) => Math.max(0, options.limit - item.count)),
  );
  const retryAfter = Math.max(
    1,
    ...entries
      .filter((item) => item.count > options.limit)
      .map((item) => Math.ceil((item.resetAt - now) / 1000)),
  );
  return {
    allowed: entries.every((item) => item.count <= options.limit),
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
