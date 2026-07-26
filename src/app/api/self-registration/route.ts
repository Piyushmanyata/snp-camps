import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { consumeVerifiedAadhaarKycSession } from "@/lib/aadhaar-kyc-session";
import { parseAadhaarDuplicateError, parseLikelyDuplicateError } from "@/lib/registration-request";
import { createServiceRoleClient } from "@/lib/supabase/admin";

type SelfRegistrationBody = {
  handle?: string;
  campId?: string;
  campDayId?: string;
};

function errorResponse(detail: string, status = 400) {
  return NextResponse.json({ ok: false, error: detail }, { status });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as SelfRegistrationBody | null;
  if (!body?.handle || !body.campId || !body.campDayId) {
    return errorResponse("Choose a Camp Day and try again.");
  }

  const verified = consumeVerifiedAadhaarKycSession(body.handle);
  if (!verified) return errorResponse("Your Aadhaar verification expired. Please start again.");
  if (verified.profile.age == null) {
    return errorResponse("Age was not returned by Aadhaar. Please register at the camp desk.");
  }

  const supabase = createServiceRoleClient();
  if (!supabase) return errorResponse("Self-registration is currently unavailable. Please use the desk.", 503);

  const { data, error } = await supabase.rpc("register_patient_idempotent", {
    p_request_id: randomUUID(),
    p_camp_id: body.campId,
    p_full_name: verified.profile.full_name,
    p_gender: verified.profile.gender,
    p_age: verified.profile.age,
    p_address: verified.profile.address,
    p_phone: verified.phone,
    p_email: verified.profile.email,
    p_aadhaar_last4: verified.aadhaarLast4,
    p_user_id: null,
    p_created_by: null,
    p_camp_day_id: body.campDayId,
    p_aadhaar_duplicate_override: false,
    p_likely_duplicate_override: false,
    p_self_service: true,
    p_aadhaar_hash: verified.aadhaarHash,
    p_aadhaar_verified_at: new Date().toISOString(),
    p_aadhaar_kyc_ref: verified.providerRef,
  });

  if (error || !data) {
    const message = error
      ? String((error as { message?: unknown }).message ?? error)
      : "";
    const aadhaarDup = parseAadhaarDuplicateError(message);
    const likelyDup = parseLikelyDuplicateError(message);
    if (aadhaarDup) {
      return NextResponse.json({
        ok: false,
        deskReferral: true,
        registrationNumber: aadhaarDup.regNo,
        error: `Aapka Aadhaar pehle se reg #${aadhaarDup.regNo} par registered hai. Kripya camp desk par milen.`,
      });
    }
    if (likelyDup) {
      return NextResponse.json({
        ok: false,
        deskReferral: true,
        registrationNumber: likelyDup.regNo,
        error: `Aapki details se milta-julta reg #${likelyDup.regNo} mila hai. Kripya camp desk par check karwayen.`,
      });
    }
    if (/aadhaar_duplicate|likely_duplicate/i.test(message)) {
      return NextResponse.json({
        ok: false,
        deskReferral: true,
        error: "Aapka registration pehle se ho chuka lagta hai. Kripya camp desk par volunteer se milen.",
      });
    }
    if (/full|seat/i.test(message)) return errorResponse("Yeh Camp Day full hai. Doosra din chunen.");
    return errorResponse("Registration nahi ho paaya. Camp desk par madad lein.", 409);
  }

  const row = (Array.isArray(data) ? data[0] : data) as { id?: string; reg_no?: number; camp_day_id?: string; day_date?: string } | null;
  if (!row?.id || row.reg_no == null) return errorResponse("Registration response incomplete. Please use the desk.", 502);

  const patient = await supabase
    .from("patients")
    .select("status_token")
    .eq("id", row.id)
    .maybeSingle();
  if (patient.error || !patient.data?.status_token) {
    return errorResponse("Registration complete. Please ask the desk for your status link.", 200);
  }
  const site = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
  return NextResponse.json({
    ok: true,
    registrationNumber: row.reg_no,
    campDayId: row.camp_day_id,
    dayDate: row.day_date,
    queueStatus: "registered",
    statusUrl: `${site}/s/${patient.data.status_token}`,
  });
}
