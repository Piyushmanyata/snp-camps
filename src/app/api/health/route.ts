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

async function phoneOtpIsConfigured() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return false;
  try {
    const response = await fetch(new URL("/auth/v1/settings", url), {
      cache: "no-store",
      headers: { apikey: anonKey },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const settings = (await response.json()) as {
      external?: { phone?: boolean };
      sms_provider?: string;
    };
    return settings.external?.phone === true && Boolean(settings.sms_provider);
  } catch {
    return false;
  }
}

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

  const [phoneOtpReady, camps, profileShape, patientShape, contract] =
    await Promise.all([
      phoneOtpIsConfigured(),
      supabase.from("camps").select("id").limit(1),
      supabase.from("profiles").select("id, disabled_at").limit(1),
      supabase
        .from("patients")
        .select("id, phone_normalized, full_name_normalized")
        .limit(1),
      supabase.rpc("app_database_contract"),
    ]);

  // Catalog-backed contract (to_regprocedure), not exception message text.
  const contractOk =
    !contract.error &&
    typeof contract.data === "string" &&
    contract.data.length > 0 &&
    contract.data !== "incomplete";
  const database =
    !camps.error &&
    !profileShape.error &&
    !patientShape.error &&
    contractOk;
  const ok = phoneOtpReady && database;

  return NextResponse.json(
    { ok, checks: { database, phoneOtp: phoneOtpReady } },
    {
      status: ok ? 200 : 503,
      headers,
    },
  );
}
