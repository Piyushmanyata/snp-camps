import "server-only";

import { createHmac } from "node:crypto";
import { rateLimitIdentifiers } from "@/lib/rate-limit-core";

type RpcResult = {
  data: unknown;
  error: unknown;
};

type RpcClient = {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<RpcResult>;
};

type Options = {
  scope: string;
  limit: number;
  windowMs: number;
  identifier?: string;
  keyType?: "ip" | "subject" | "both";
};

export type DistributedRateLimitResult = {
  allowed: boolean;
  unavailable: boolean;
  retryAfterSeconds: number;
};

/** Dedicated secret only — never fall back to the service-role key. */
function signingSecret() {
  return process.env.RATE_LIMIT_SECRET?.trim() || "";
}

/**
 * Durable abuse protection shared by all serverless instances. The database
 * receives only keyed digests, never a raw address or patient identifier.
 */
export async function checkDistributedRateLimit(
  request: Request,
  client: RpcClient,
  options: Options,
): Promise<DistributedRateLimitResult> {
  const secret = signingSecret();
  if (!secret) {
    return { allowed: false, unavailable: true, retryAfterSeconds: 1 };
  }

  const keyHashes = rateLimitIdentifiers(
    request,
    options.identifier,
    options.keyType,
  ).map(
    (identifier) =>
      createHmac("sha256", secret).update(identifier).digest("base64url"),
  );
  const { data, error } = await client.rpc("consume_public_rate_limit", {
    p_scope: options.scope,
    p_key_hashes: keyHashes,
    p_limit: options.limit,
    p_window_seconds: Math.max(1, Math.ceil(options.windowMs / 1000)),
  });

  const row = Array.isArray(data) ? data[0] : data;
  if (
    error ||
    !row ||
    typeof row !== "object" ||
    typeof (row as { allowed?: unknown }).allowed !== "boolean"
  ) {
    return { allowed: false, unavailable: true, retryAfterSeconds: 1 };
  }

  const retryAfter = Number(
    (row as { retry_after_seconds?: unknown }).retry_after_seconds,
  );
  return {
    allowed: (row as { allowed: boolean }).allowed,
    unavailable: false,
    retryAfterSeconds:
      Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : 1,
  };
}
