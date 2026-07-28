import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { isNonLatinText } from "@/lib/aadhaar-text";
import { derivePersonDuplicateKey } from "@/lib/person-duplicate-key";
import {
  parseAadhaarDuplicateError,
  parseLikelyDuplicateError,
} from "@/lib/registration-request";
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

/** Public write endpoint: bound it per instance. A WAF rule still belongs in front. */
const SELF_REGISTRATION_RATE_LIMIT = {
  scope: "self-registration",
  limit: 10,
  windowMs: 10 * 60_000,
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
  const rate = checkRateLimit(request, SELF_REGISTRATION_RATE_LIMIT);
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, error: "Bahut zyada koshish. Thodi der baad try karein." },
      { status: 429, headers: rate.headers },
    );
  }

  const body = (await request.json().catch(() => null)) as SelfRegistrationBody | null;
  const campId = str(body?.campId);
  const campDayId = str(body?.campDayId);
  if (!campId || !campDayId) {
    return errorResponse("Ek Camp Day chunkar dobara try karein.");
  }

  const card = body?.card ?? {};
  const fullName = str(card.fullName);
  const gender = str(card.gender);
  const address = str(card.address);
  const dateOfBirth = str(card.dateOfBirth);
  const aadhaarLast4 = str(card.aadhaarLast4).replace(/\D/g, "").slice(-4);
  const age = typeof card.age === "number" && Number.isInteger(card.age) ? card.age : null;
  const phone = str(body?.phone).replace(/\D/g, "").slice(-10);

  if (!fullName || !gender || !dateOfBirth || aadhaarLast4.length !== 4 || age == null) {
    return errorResponse(
      "Aadhaar card poora scan nahi hua. Kripya dobara scan karein ya camp desk par register karayein.",
    );
  }
  if (phone.length !== 10) {
    return errorResponse("10-digit mobile number daalein. Yeh Aadhaar card par nahi hota.");
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

  const { data, error } = await supabase.rpc("register_patient_idempotent", {
    p_request_id: randomUUID(),
    p_camp_id: campId,
    p_full_name: fullName,
    p_gender: gender,
    p_age: age,
    p_address: address || null,
    p_phone: phone,
    p_email: null,
    p_aadhaar_last4: aadhaarLast4,
    // Patients hold no Auth identity (#59) and no staff created this row.
    p_user_id: null,
    p_created_by: null,
    p_camp_day_id: campDayId,
    p_aadhaar_duplicate_override: false,
    p_likely_duplicate_override: false,
    p_self_service: true,
    // Retired with the eKYC flow (#116); the columns remain for historical rows.
    p_aadhaar_hash: null,
    p_aadhaar_verified_at: null,
    p_aadhaar_kyc_ref: null,
    p_provenance: "card_verified",
    p_duplicate_key: duplicateKey,
    p_date_of_birth: dateOfBirth,
    p_display_name: displayName || null,
  });

  if (error || !data) {
    const message = error ? String((error as { message?: unknown }).message ?? error) : "";
    const aadhaarDup = parseAadhaarDuplicateError(message);
    const likelyDup = parseLikelyDuplicateError(message);
    const dupRegNo = aadhaarDup?.regNo ?? likelyDup?.regNo ?? null;
    if (dupRegNo != null) {
      return NextResponse.json({
        ok: false,
        deskReferral: true,
        registrationNumber: dupRegNo,
        error: `Aapki details se milta-julta reg #${dupRegNo} mila hai. Kripya camp desk par check karwayen.`,
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
    return errorResponse("Registration ho gaya. Status link ke liye desk se poochein.", 200);
  }

  const site = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
  return NextResponse.json({
    ok: true,
    patientId: row.id,
    registrationNumber: row.reg_no,
    campDayId: row.camp_day_id,
    dayDate: row.day_date,
    queueStatus: "registered",
    statusUrl: `${site}/s/${patient.data.status_token}`,
  });
}
