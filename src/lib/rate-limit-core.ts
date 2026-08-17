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
  keyType?: "ip" | "subject" | "both";
};

const globalStore = globalThis as typeof globalThis & {
  __snpRateLimits?: Map<string, Entry>;
  __snpRateLimitSweepAt?: number;
};

const store = globalStore.__snpRateLimits ?? new Map<string, Entry>();
globalStore.__snpRateLimits = store;

// Off-Vercel every forwarding header is attacker-settable, so none is trusted:
// rotating one used to buy a fresh bucket and defeat the throttle.
function clientAddress(request: Request) {
  const onVercel =
    process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
  if (!onVercel) return "unknown";
  return (
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
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

export function rateLimitIdentifiers(
  request: Request,
  identifier?: string,
  keyType: "ip" | "subject" | "both" = "both",
) {
  const keys: string[] = [];
  if (keyType === "ip" || keyType === "both") {
    keys.push(`ip:${hashValue(clientAddress(request))}`);
  }
  const subject = identifier?.trim();
  if (subject && (keyType === "subject" || keyType === "both")) {
    keys.push(`subject:${hashValue(subject)}`);
  }
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

export function checkRateLimit(request: Request, options: Options) {
  const now = Date.now();
  sweepExpired(now);

  const keys = rateLimitIdentifiers(
    request,
    options.identifier,
    options.keyType,
  ).map(
    (key) => `${options.scope}:${key}`,
  );

  if (keys.length === 0) {
    return {
      allowed: false,
      headers: {
        "RateLimit-Limit": String(options.limit),
        "RateLimit-Remaining": "0",
        "RateLimit-Reset": String(Math.ceil((now + options.windowMs) / 1000)),
        "Retry-After": "1",
      },
    };
  }

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
