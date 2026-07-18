import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";

const cacheHeaders = {
  "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=30",
};

export async function GET(request: Request) {
  const ready = new URL(request.url).searchParams.get("ready") === "1";
  if (!ready) {
    return NextResponse.json({ ok: true }, { headers: cacheHeaders });
  }

  const supabase = createServiceRoleClient();
  if (!supabase || !process.env.AADHAAR_VERIFY_URL?.trim()) {
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: cacheHeaders },
    );
  }

  const [camps, patientShape, verificationStore, verifiedRegistration] =
    await Promise.all([
      supabase.from("camps").select("id").limit(1),
      supabase
        .from("patients")
        .select(
          "id, phone_normalized, full_name_normalized, account_claim_token, account_claim_expires_at",
        )
        .limit(1),
      supabase
        .from("registration_verifications")
        .select("token_hash, expires_at, consumed_at")
        .limit(1),
      supabase.rpc("register_verified_patient", {
        p_verification_token: "0".repeat(64),
        p_camp_id: "00000000-0000-0000-0000-000000000000",
        p_full_name: "Readiness probe",
        p_camp_day_id: "00000000-0000-0000-0000-000000000000",
      }),
    ]);
  const rpcExists = Boolean(
    verifiedRegistration.error &&
      /verification/i.test(verifiedRegistration.error.message),
  );
  const ok =
    !camps.error &&
    !patientShape.error &&
    !verificationStore.error &&
    rpcExists;

  return NextResponse.json(
    { ok },
    {
      status: ok ? 200 : 503,
      headers: cacheHeaders,
    },
  );
}
