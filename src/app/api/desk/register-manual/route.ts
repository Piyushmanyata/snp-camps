import { NextResponse } from "next/server";
import { loadSessionProfile, readJsonBody } from "@/lib/auth";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { MANUAL_EXCEPTION_ATTEMPT_THRESHOLD } from "@/lib/manual-exception-attempts";
import {
  validateRegistrationIds,
  validateRegistrationIdentity,
  validateRegistrationPhone,
} from "@/lib/registration-input";
import { mapDbError } from "@/lib/public-error";
import { isStaff } from "@/lib/roles";

type Body = Record<string, unknown>;
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

function fail(message: string, status = 400) {
  return NextResponse.json({ data: null, error: { message } }, { status });
}

export async function POST(request: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId) return fail("Not signed in", 401);
  if (!isStaff(profile?.role)) {
    return fail("Only Registration Staff can record a manual exception.", 403);
  }
  const body = await readJsonBody<Body>(request, 16_384);
  if (!body) return fail("Invalid JSON body");
  const attempts = Number(body.failedScanAttempts);
  const reason = text(body.reason).slice(0, 160);
  const phone = validateRegistrationPhone(body.phone);
  if (
    !Number.isInteger(attempts) ||
    attempts < MANUAL_EXCEPTION_ATTEMPT_THRESHOLD ||
    !reason ||
    !phone.ok
  ) {
    return fail(
      "Two failed scan attempts, a reason, and a valid household phone number are required.",
    );
  }
  const requestId = text(body.requestId);
  const campId = text(body.campId);
  const campDayId = text(body.campDayId);
  const fullName = text(body.fullName);
  const gender = text(body.gender).toUpperCase();
  const age = Number(body.age);
  const idValidation = validateRegistrationIds({
    requestId,
    campId,
    campDayId,
  });
  const identityValidation = validateRegistrationIdentity({
    fullName,
    displayName: body.displayName,
    address: body.address,
    gender,
    age,
    dateOfBirth: body.dateOfBirth,
    selfService: false,
  });
  if (!idValidation.ok || !identityValidation.ok) {
    return fail(
      "Invalid registration session. Reload desk and try again.",
    );
  }
  const supabase = createServiceRoleClient();
  if (!supabase) return fail("Registration service is unavailable. Contact admin.", 503);
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
    return fail(
      mapDbError(error, {
        context: "manual-registration",
        fallback: "Manual registration failed. Please try again.",
      }),
      409,
    );
  }
  return NextResponse.json({ data, error: null });
}
