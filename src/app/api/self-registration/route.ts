import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { isNonLatinText } from "@/lib/aadhaar-text";
import { checkDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { derivePersonDuplicateKey } from "@/lib/person-duplicate-key";
import {
  parseAadhaarDuplicateError,
  parseLikelyDuplicateError,
} from "@/lib/registration-request";
import {
  validateAadhaarLast4,
  validateRegistrationIds,
  validateRegistrationIdentity,
  validateRegistrationPhone,
} from "@/lib/registration-input";
import { createServiceRoleClient } from "@/lib/supabase/admin";

const SELF_REGISTRATION_IP_RATE_LIMIT = {
  scope: "self-registration-ip",
  limit: 300,
  windowMs: 10 * 60_000,
  keyType: "ip" as const,
};
const SELF_REGISTRATION_SUBJECT_RATE_LIMIT = {
  scope: "self-registration-subject",
  limit: 5,
  windowMs: 10 * 60_000,
  keyType: "subject" as const,
};

type ScannedCard = {
  fullName?: unknown;
  displayName?: unknown;
  gender?: unknown;
  age?: unknown;
  address?: unknown;
  aadhaarLast4?: unknown;
  dateOfBirth?: unknown;
};

type SelfRegistrationBody = {
  requestId?: unknown;
  campId?: unknown;
  campDayId?: unknown;
  phone?: unknown;
  card?: ScannedCard;
};

function errorResponse(detail: string, status = 400) {
  return NextResponse.json({ ok: false, error: detail }, { status });
}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export async function POST(request: Request) {
  const rate = checkRateLimit(request, SELF_REGISTRATION_IP_RATE_LIMIT);
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Please try again later." },
      { status: 429, headers: rate.headers },
    );
  }

  const body = await readJsonBody<SelfRegistrationBody>(request, 16_384);
  if (!body) return errorResponse("Invalid JSON body.");
  const campId = str(body.campId);
  const campDayId = str(body.campDayId);
  const requestId = str(body.requestId);
  const idValidation = validateRegistrationIds({
    requestId,
    campId,
    campDayId,
  });
  if (!idValidation.ok) {
    return errorResponse(idValidation.message);
  }

  const card = body.card ?? {};
  const fullName = str(card.fullName);
  const gender = str(card.gender).toUpperCase();
  const address = str(card.address);
  const dateOfBirth = str(card.dateOfBirth);
  const aadhaarLast4 = str(card.aadhaarLast4);
  const age = typeof card.age === "number" && Number.isInteger(card.age) ? card.age : null;
  const phoneResult = validateRegistrationPhone(body.phone);

  const identityValidation = validateRegistrationIdentity({
    fullName,
    displayName: card.displayName,
    address,
    gender,
    age,
    dateOfBirth,
    selfService: true,
  });
  if (!identityValidation.ok || !validateAadhaarLast4(aadhaarLast4)) {
    return errorResponse(
      "Aadhaar card was not fully scanned. Please scan again or register at the camp desk.",
    );
  }
  if (!phoneResult.ok) {
    return errorResponse(
      "Enter a 10-digit mobile number starting with 6–9. Repeated digits (such as 0000000000) are not allowed.",
    );
  }

  const displayName = str(card.displayName);
  if (isNonLatinText(fullName) && !displayName) {
    return errorResponse("Please enter your name in English letters as well.");
  }
  if (displayName && isNonLatinText(displayName)) {
    return errorResponse("English spelling must contain English letters only.");
  }

  let duplicateKey: string;
  try {
    duplicateKey = derivePersonDuplicateKey({
      name: fullName,
      aadhaarLast4,
      dateOfBirth,
      gender,
    });
  } catch (err) {
    console.error("[self-registration] person key failed", err);
    return errorResponse(
      "Self-registration is currently unavailable. Please register at the camp desk.",
      503,
    );
  }

  const supabase = createServiceRoleClient();
  if (!supabase) {
    return errorResponse(
      "Self-registration is currently unavailable. Please register at the camp desk.",
      503,
    );
  }

  const durableIpRate = await checkDistributedRateLimit(
    request,
    supabase,
    SELF_REGISTRATION_IP_RATE_LIMIT,
  );
  if (!durableIpRate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: durableIpRate.unavailable
          ? "Self-registration is currently unavailable. Please register at the camp desk."
          : "Too many attempts. Please try again later.",
      },
      {
        status: durableIpRate.unavailable ? 503 : 429,
        headers: { "Retry-After": String(durableIpRate.retryAfterSeconds) },
      },
    );
  }

  const durableSubjectRate = await checkDistributedRateLimit(request, supabase, {
    ...SELF_REGISTRATION_SUBJECT_RATE_LIMIT,
    identifier: duplicateKey,
  });
  if (!durableSubjectRate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: durableSubjectRate.unavailable
          ? "Self-registration is currently unavailable. Please register at the camp desk."
          : "Too many attempts. Please try again later.",
      },
      {
        status: durableSubjectRate.unavailable ? 503 : 429,
        headers: {
          "Retry-After": String(durableSubjectRate.retryAfterSeconds),
        },
      },
    );
  }

  const { data, error } = await supabase.rpc("register_patient_idempotent", {
    p_request_id: requestId,
    p_camp_id: campId,
    p_full_name: fullName,
    p_gender: gender,
    p_age: age,
    p_address: address || null,
    p_phone: phoneResult.phone,
    p_email: null,
    p_aadhaar_last4: aadhaarLast4,
    // Patients hold no Auth identity (#59) and no staff created this row.
    p_user_id: null,
    p_created_by: null,
    p_camp_day_id: campDayId,
    p_aadhaar_duplicate_override: false,
    p_likely_duplicate_override: false,
    p_self_service: true,
    p_provenance: "card_scanned",
    p_duplicate_key: duplicateKey,
    p_date_of_birth: dateOfBirth,
    p_display_name: displayName || null,
  });

  if (error || !data) {
    const message = error ? String((error as { message?: unknown }).message ?? error) : "";
    const aadhaarDup = parseAadhaarDuplicateError(message);
    const likelyDup = parseLikelyDuplicateError(message);
    if (aadhaarDup?.regNo != null) {
      const dupRegNo = aadhaarDup.regNo;
      const existing = await supabase
        .from("patients")
        .select("id, reg_no, camp_day_id, queue_status")
        .eq("camp_id", campId)
        .eq("reg_no", dupRegNo)
        .maybeSingle();

      const row = existing.data;
      if (row?.id && row.reg_no != null) {
        let dayDate: string | null = null;
        if (row.camp_day_id) {
          const day = await supabase
            .from("camp_days")
            .select("day_date")
            .eq("id", row.camp_day_id)
            .maybeSingle();
          dayDate =
            day.data?.day_date != null ? String(day.data.day_date) : null;
        }
        return NextResponse.json({
          ok: true,
          existing: true,
          patientId: row.id,
          registrationNumber: row.reg_no,
          campDayId: row.camp_day_id,
          dayDate,
          queueStatus: row.queue_status ?? "registered",
        });
      }
      return NextResponse.json({
        ok: false,
        deskReferral: true,
        registrationNumber: dupRegNo,
        error: `A matching registration (#${dupRegNo}) was found with your details. Please check at the camp desk.`,
      });
    }
    if (likelyDup?.regNo != null) {
      return NextResponse.json({
        ok: false,
        deskReferral: true,
        registrationNumber: likelyDup.regNo,
        error: `A matching registration (#${likelyDup.regNo}) was found with your details. Please check at the camp desk.`,
      });
    }
    if (/full|seat/i.test(message)) {
      return errorResponse("This camp day is full. Please choose another day.");
    }
    console.error("[self-registration] rpc failed", message);
    return errorResponse("Registration could not be completed. Please ask for assistance at the camp desk.", 409);
  }

  const row = (Array.isArray(data) ? data[0] : data) as {
    id?: string;
    reg_no?: number;
    camp_day_id?: string;
    day_date?: string;
  } | null;
  if (!row?.id || row.reg_no == null) {
    return errorResponse("Registration was incomplete. Please visit the camp desk.", 502);
  }

  const stored = await supabase
    .from("patients")
    .select("registration_request_id, queue_status")
    .eq("id", row.id)
    .maybeSingle();
  const storedRequestId =
    typeof stored.data?.registration_request_id === "string"
      ? stored.data.registration_request_id
      : null;
  const existing = Boolean(storedRequestId && storedRequestId !== requestId);
  const queueStatus = stored.data?.queue_status === "seen" ? "seen" : "registered";

  return NextResponse.json({
    ok: true,
    existing,
    patientId: row.id,
    registrationNumber: row.reg_no,
    campDayId: row.camp_day_id,
    dayDate: row.day_date,
    queueStatus,
  });
}
