import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";

const cacheHeaders = {
  "Cache-Control": "no-store",
};

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

  const supabase = createServiceRoleClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: cacheHeaders },
    );
  }

  const [phoneOtpReady, camps, profileShape, patientShape, phoneLinkRpc] =
    await Promise.all([
      phoneOtpIsConfigured(),
      supabase.from("camps").select("id").limit(1),
      supabase.from("profiles").select("id, disabled_at").limit(1),
      supabase
        .from("patients")
        .select(
          "id, phone_normalized, full_name_normalized, account_claim_token, account_claim_expires_at",
        )
        .limit(1),
      supabase.rpc("link_patient_phone", { p_phone: "" }),
    ]);
  const rpcExists = Boolean(
    phoneLinkRpc.error && /sign in required/i.test(phoneLinkRpc.error.message),
  );
  const ok =
    phoneOtpReady &&
    !camps.error &&
    !profileShape.error &&
    !patientShape.error &&
    rpcExists;

  return NextResponse.json(
    { ok, checks: { database: !camps.error && !profileShape.error && !patientShape.error && rpcExists, phoneOtp: phoneOtpReady } },
    {
      status: ok ? 200 : 503,
      headers: cacheHeaders,
    },
  );
}
