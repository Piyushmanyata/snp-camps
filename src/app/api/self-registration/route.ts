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

/**
 * Self-registration from an Aadhaar card scan (#113).
 *
 * No OTP, no eKYC provider, no registration SMS: the card is parsed in the
 * patient's browser and assumed authentic (ADR 0004), and the confirmation
 * screen is the receipt. The registration SMS is deliberately withheld because
 * it embeds a live status link and the typed phone number is unverified — one
 * mistyped digit would deliver a working medical status link to a stranger.
 */

/** Public write endpoint: a generous IP ceiling plus a durable subject gate. */
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
  /** Client-stable UUID for idempotent retries. */
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

/** Same-origin status path only — never absolute external URLs. */
function statusPath(token: string) {
  return `/s/${token}`;
}

export async function POST(request: Request) {
  // Instance-local abuse ceiling runs before body parsing by design.
  const rate = checkRateLimit(request, SELF_REGISTRATION_IP_RATE_LIMIT);
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, error: "Bahut zyada koshish. Thodi der baad try karein." },
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
      "Aadhaar card poora scan nahi hua. Kripya dobara scan karein ya camp desk par register karayein.",
    );
  }
  if (!phoneResult.ok) {
    return errorResponse(
      "10-digit mobile number daalein (6–9 se shuru). Dummy numbers (jaise 0000000000) nahi chalenge.",
    );
  }

  // The duplicate key and name-search both assume a Latin alphabet, so a
  // Devanagari card name needs a Latin spelling before it can be stored.
  const displayName = str(card.displayName);
  if (isNonLatinText(fullName) && !displayName) {
    return errorResponse("Apna naam English letters mein bhi likhein.");
  }
  if (displayName && isNonLatinText(displayName)) {
    return errorResponse("English spelling sirf English letters mein likhein.");
  }

  let duplicateKey: string;
  try {
    // Verbatim card name — never the transliteration — so two different
    // spellings of one card can never mint two Persons.
    duplicateKey = derivePersonDuplicateKey({
      name: fullName,
      aadhaarLast4,
      dateOfBirth,
      gender,
    });
  } catch (err) {
    console.error("[self-registration] person key failed", err);
    return errorResponse(
      "Self-registration abhi available nahi hai. Kripya camp desk par register karayein.",
      503,
    );
  }

  const supabase = createServiceRoleClient();
  if (!supabase) {
    return errorResponse(
      "Self-registration abhi available nahi hai. Kripya camp desk par register karayein.",
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
          ? "Self-registration abhi available nahi hai. Kripya camp desk par register karayein."
          : "Bahut zyada koshish. Thodi der baad try karein.",
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
          ? "Self-registration abhi available nahi hai. Kripya camp desk par register karayein."
          : "Bahut zyada koshish. Thodi der baad try karein.",
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
    // Same-card (hard Person key) re-scan may return the status link.
    // Soft name+age likely-duplicates must NOT leak a stranger's bearer token.
    if (aadhaarDup?.regNo != null) {
      const dupRegNo = aadhaarDup.regNo;
      const existing = await supabase
        .from("patients")
        .select("id, reg_no, status_token, camp_day_id, queue_status")
        .eq("reg_no", dupRegNo)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const row = existing.data;
      if (row?.id && row.status_token && row.reg_no != null) {
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
          statusUrl: statusPath(String(row.status_token)),
        });
      }
      return NextResponse.json({
        ok: false,
        deskReferral: true,
        registrationNumber: dupRegNo,
        error: `Aapki details se milta-julta reg #${dupRegNo} mila hai. Kripya camp desk par check karwayen.`,
      });
    }
    if (likelyDup?.regNo != null) {
      return NextResponse.json({
        ok: false,
        deskReferral: true,
        registrationNumber: likelyDup.regNo,
        error: `Aapki details se milta-julta reg #${likelyDup.regNo} mila hai. Kripya camp desk par check karwayen.`,
      });
    }
    if (/full|seat/i.test(message)) {
      return errorResponse("Yeh Camp Day full hai. Doosra din chunen.");
    }
    console.error("[self-registration] rpc failed", message);
    return errorResponse("Registration nahi ho paaya. Camp desk par madad lein.", 409);
  }

  const row = (Array.isArray(data) ? data[0] : data) as {
    id?: string;
    reg_no?: number;
    camp_day_id?: string;
    day_date?: string;
  } | null;
  if (!row?.id || row.reg_no == null) {
    return errorResponse("Registration adhoora raha. Kripya camp desk par milen.", 502);
  }

  const patient = await supabase
    .from("patients")
    .select("status_token")
    .eq("id", row.id)
    .maybeSingle();
  if (patient.error || !patient.data?.status_token) {
    return NextResponse.json({
      ok: true,
      patientId: row.id,
      registrationNumber: row.reg_no,
      campDayId: row.camp_day_id,
      dayDate: row.day_date,
      queueStatus: "registered",
      statusUrl: null,
    });
  }

  return NextResponse.json({
    ok: true,
    patientId: row.id,
    registrationNumber: row.reg_no,
    campDayId: row.camp_day_id,
    dayDate: row.day_date,
    queueStatus: "registered",
    statusUrl: statusPath(String(patient.data.status_token)),
  });
}
