import { NextResponse } from "next/server";
import { loadSessionProfile, readJsonBody } from "@/lib/auth";
import { validateHouseholdPhone } from "@/lib/phone";
import { isPatientUuid } from "@/lib/qr";
import { createServiceRoleClient } from "@/lib/supabase/admin";

type Body = Record<string, unknown>;
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

function fail(message: string, status = 400) {
  return NextResponse.json({ data: null, error: { message } }, { status });
}

/** Audited exception only; normal desk registration always uses Aadhaar QR. */
export async function POST(request: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId) return fail("Not signed in", 401);
  if (profile?.role !== "admin" && profile?.role !== "team_lead") {
    return fail("Ask a Team Lead to complete the manual exception.", 403);
  }
  const body = await readJsonBody<Body>(request, 16_384);
  if (!body) return fail("Invalid JSON body");
  const attempts = Number(body.failedScanAttempts);
  const reason = text(body.reason).slice(0, 160);
  const phone = validateHouseholdPhone(text(body.phone));
  if (!Number.isInteger(attempts) || attempts < 3 || !reason || !phone.ok) {
    return fail(
      "Three failed scans, a reason, and a valid household phone are required.",
    );
  }
  const requestId = text(body.requestId);
  const campId = text(body.campId);
  const campDayId = text(body.campDayId);
  const fullName = text(body.fullName);
  const gender = text(body.gender).toUpperCase();
  const age = Number(body.age);
  if (
    !isPatientUuid(requestId) ||
    !isPatientUuid(campId) ||
    !isPatientUuid(campDayId)
  ) {
    return fail(
      "Registration session is invalid. Reload the desk and try again.",
    );
  }
  if (!fullName) {
    return fail("Enter the patient's full name.");
  }
  if (!["M", "F", "O"].includes(gender)) {
    return fail("Select M, F or O.");
  }
  if (!Number.isInteger(age) || age < 0 || age > 149) {
    return fail("Enter an age between 0 and 149.");
  }
  const supabase = createServiceRoleClient();
  if (!supabase) return fail("Registration service unavailable.", 503);
  const { data, error } = await supabase.rpc("register_manual_exception", {
    p_request_id: requestId,
    p_camp_id: campId,
    p_camp_day_id: campDayId,
    p_full_name: fullName,
    p_display_name: text(body.displayName) || null,
    p_gender: gender,
    p_age: age,
    p_address: text(body.address) || null,
    p_phone: phone.phone,
    p_reason: reason,
    p_failed_scan_attempts: attempts,
    p_actor_id: userId,
  });
  if (error) {
    console.error("[manual-registration] failed", {
      code: error.code,
      message: error.message,
    });
    return fail("Manual registration failed. Try again.", 409);
  }
  return NextResponse.json({ data, error: null });
}
