import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";

const cacheHeaders = {
  "Cache-Control": "no-store",
};

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
  if (!supabase) {
    return NextResponse.json(
      { ok: false },
      { status: 503, headers },
    );
  }

  const [camps, profileShape, patientShape, migrationHead] = await Promise.all([
    supabase.from("camps").select("id").limit(1),
    supabase.from("profiles").select("id, disabled_at").limit(1),
    supabase
      .from("patients")
      .select("id, phone_normalized, full_name_normalized, status_token")
      .limit(1),
    supabase.rpc("latest_applied_migration"),
  ]);

  const migrationVersion =
    !migrationHead.error && typeof migrationHead.data === "string"
      ? migrationHead.data
      : null;
  const database =
    !camps.error && !profileShape.error && !patientShape.error;
  const ok = database;

  return NextResponse.json(
    {
      ok,
      checks: { database },
      migrationVersion,
    },
    {
      status: ok ? 200 : 503,
      headers,
    },
  );
}
