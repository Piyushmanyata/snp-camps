import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  evaluateReadiness,
  readinessResponseBody,
} from "@/lib/readiness";

const cacheHeaders = {
  "Cache-Control": "no-store",
};

/**
 * Liveness: GET /api/health  → always cheap { ok: true } (no DB).
 * Readiness: GET /api/health?ready=1 → fail-closed catalog/migration checks (#68).
 * Liveness stays independent of readiness so process probes never trip on drift.
 */
/** Expensive readiness probes only — liveness stays unlimited. */
const READY_RATE = {
  scope: "health-ready",
  limit: 12,
  windowMs: 60_000,
} as const;

export async function GET(request: Request) {
  const ready = new URL(request.url).searchParams.get("ready") === "1";
  if (!ready) {
    return NextResponse.json({ ok: true }, { headers: cacheHeaders });
  }

  const rate = checkRateLimit(request, READY_RATE);
  const headers = { ...cacheHeaders, ...rate.headers };
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many readiness checks. Try again later." },
      { status: 429, headers },
    );
  }

  const supabase = createServiceRoleClient();
  const result = await evaluateReadiness(supabase);

  return NextResponse.json(readinessResponseBody(result), {
    status: result.ok ? 200 : 503,
    headers,
  });
}
