import { NextResponse } from "next/server";
import { loadSessionProfile, readJsonBody } from "@/lib/auth";
import { isStaff } from "@/lib/roles";
import { derivePersonDuplicateKey } from "@/lib/person-duplicate-key";
import {
  parseAadhaarDuplicateError,
  parseLikelyDuplicateError,
} from "@/lib/registration-request";
import { createServiceRoleClient } from "@/lib/supabase/admin";

type ScannedDeskRegistrationBody = {
  requestId?: unknown;
  campId?: unknown;
  campDayId?: unknown;
  fullName?: unknown;
  displayName?: unknown;
  gender?: unknown;
  age?: unknown;
  address?: unknown;
  phone?: unknown;
  email?: unknown;
  aadhaarLast4?: unknown;
  dateOfBirth?: unknown;
};

const str = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

function failure(message: string, status: number, code?: string) {
  return NextResponse.json(
    { data: null, error: { message, code: code ?? String(status) } },
    { status },
  );
}

/**
 * Trusted scanned-card registration boundary.
 *
 * The Aadhaar Person key is derived only on the server and is never returned to
 * the browser. The service-role RPC is deliberately constrained to the signed-in
 * staff member, card-scanned provenance, and no duplicate overrides.
 */
export async function POST(request: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId) return failure("Not signed in", 401, "AUTH_REQUIRED");
  if (!isStaff(profile?.role)) {
    return failure("Registration is available to camp staff only.", 403, "FORBIDDEN");
  }

  const body = await readJsonBody<ScannedDeskRegistrationBody>(request, 16_384);
  if (!body) return failure("Invalid JSON body", 400, "INVALID_BODY");

  const requestId = str(body.requestId);
  const campId = str(body.campId);
  const campDayId = str(body.campDayId);
  const fullName = str(body.fullName);
  const displayName = str(body.displayName);
  const gender = str(body.gender).toUpperCase();
  const address = str(body.address);
  const phone = str(body.phone).replace(/\D/g, "").slice(-10);
  const email = str(body.email);
  const aadhaarLast4 = str(body.aadhaarLast4).replace(/\D/g, "").slice(-4);
  const dateOfBirth = str(body.dateOfBirth);
  const age =
    typeof body.age === "number" && Number.isInteger(body.age) ? body.age : null;

  if (
    !requestId ||
    !campId ||
    !campDayId ||
    !fullName ||
    !dateOfBirth ||
    aadhaarLast4.length !== 4 ||
    !["M", "F", "O"].includes(gender) ||
    age == null
  ) {
    return failure(
      "The Aadhaar card scan is incomplete. Scan again or switch to manual entry.",
      400,
      "INCOMPLETE_SCAN",
    );
  }

  let duplicateKey: string;
  try {
    duplicateKey = derivePersonDuplicateKey({
      name: fullName,
      aadhaarLast4,
      dateOfBirth,
      gender,
    });
  } catch (error) {
    console.error("[desk-register-scanned] person key failed", error);
    return failure(
      "Scanned-card registration is temporarily unavailable. Switch to manual entry.",
      503,
      "PERSON_KEY_UNAVAILABLE",
    );
  }

  const supabase = createServiceRoleClient();
  if (!supabase) {
    return failure(
      "Registration service is temporarily unavailable.",
      503,
      "SERVICE_UNAVAILABLE",
    );
  }

  const { data, error } = await supabase.rpc("register_patient_idempotent", {
    p_request_id: requestId,
    p_camp_id: campId,
    p_full_name: fullName,
    p_gender: gender,
    p_age: age,
    p_address: address || null,
    p_phone: phone || null,
    p_email: email || null,
    p_aadhaar_last4: aadhaarLast4,
    p_user_id: null,
    p_created_by: userId,
    p_camp_day_id: campDayId,
    p_aadhaar_duplicate_override: false,
    p_likely_duplicate_override: false,
    p_self_service: false,
    p_provenance: "card_scanned",
    p_duplicate_key: duplicateKey,
    p_date_of_birth: dateOfBirth,
    p_display_name: displayName || null,
  });

  if (error) {
    const message = String(error.message ?? error);
    const knownDuplicate =
      parseAadhaarDuplicateError(message) || parseLikelyDuplicateError(message);
    if (knownDuplicate) {
      return failure(message, 409, "DUPLICATE");
    }
    if (/full|seat/i.test(message)) {
      return failure("This camp day is full. Select another day.", 409, "DAY_FULL");
    }
    console.error("[desk-register-scanned] rpc failed", {
      code: error.code,
      message,
    });
    return failure("Registration failed. Try again or switch to manual entry.", 503);
  }

  return NextResponse.json({ data, error: null });
}
