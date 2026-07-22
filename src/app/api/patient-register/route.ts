import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { normalizePhoneE164 } from "@/lib/phone";

type Body = {
  requestId?: string;
  campId?: string;
  campDayId?: string;
  fullName?: string;
  gender?: string | null;
  age?: number | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Optional last-4 only; never full Aadhaar. */
  aadhaarLast4?: string | null;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function publicError(message?: string) {
  if (!message) return "Registration failed. Try again or ask the desk.";
  if (/day is full|select a camp day/i.test(message)) {
    return "That camp day is full. Choose another day.";
  }
  if (/already registered|duplicate key/i.test(message)) {
    return "A matching registration already exists for this camp.";
  }
  if (/verification/i.test(message)) {
    return "Verification expired. Verify again.";
  }
  if (/active camp|invalid camp day/i.test(message)) {
    return "The selected camp or day is no longer available.";
  }
  if (/phone/i.test(message)) {
    return "Enter a valid phone number, or leave phone blank at the desk.";
  }
  return "Registration failed. Try again or ask the desk.";
}

function normalizePhone10(raw: string | null | undefined) {
  return normalizePhoneE164(String(raw || ""))?.slice(-10) || "";
}

export async function POST(request: Request) {
  const body = await readJsonBody<Body>(request);
  if (!body) {
    return NextResponse.json(
      { error: "Invalid or oversized JSON body" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const requestId = String(body.requestId || "").trim();
  const campId = String(body.campId || "").trim();
  const campDayId = String(body.campDayId || "").trim();
  const fullName = String(body.fullName || "").trim();
  const address = String(body.address || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const phone = normalizePhone10(body.phone);
  const aadhaarLast4 = String(body.aadhaarLast4 || "")
    .replace(/\D/g, "")
    .slice(-4);
  const gender = ["M", "F", "O"].includes(String(body.gender))
    ? String(body.gender)
    : null;
  const rawAge = body.age as unknown;
  const age =
    rawAge == null
      ? null
      : typeof rawAge === "number" && Number.isInteger(rawAge)
        ? rawAge
        : typeof rawAge === "string" && /^\d+$/.test(rawAge.trim())
          ? Number(rawAge)
          : Number.NaN;

  const rate = checkRateLimit(request, {
    scope: "patient-register",
    identifier: phone || "missing",
    limit: 8,
    windowMs: 10 * 60_000,
  });
  const headers = {
    ...rate.headers,
    "Cache-Control": "no-store, max-age=0",
  };
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many registration attempts. Try again later." },
      { status: 429, headers },
    );
  }

  if (!UUID.test(requestId) || !UUID.test(campId) || !UUID.test(campDayId)) {
    return NextResponse.json(
      { error: "A valid registration request and camp day are required." },
      { status: 400, headers },
    );
  }
  if (!fullName || fullName.length > 120) {
    return NextResponse.json(
      { error: "Full name is required and must be under 120 characters." },
      { status: 400, headers },
    );
  }
  if (age === null || !Number.isInteger(age) || age < 0 || age > 149) {
    return NextResponse.json(
      { error: "Age is required (whole number from 0 to 149)." },
      { status: 400, headers },
    );
  }
  if (!address || address.length < 2) {
    return NextResponse.json(
      { error: "Address is required." },
      { status: 400, headers },
    );
  }
  if (address.length > 500 || email.length > 254) {
    return NextResponse.json(
      { error: "Address or email is too long." },
      { status: 400, headers },
    );
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { error: "Enter a valid email address." },
      { status: 400, headers },
    );
  }
  if (aadhaarLast4 && aadhaarLast4.length !== 4) {
    return NextResponse.json(
      { error: "Aadhaar last 4 must be 4 digits." },
      { status: 400, headers },
    );
  }

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Registration service is unavailable." },
      { status: 503, headers },
    );
  }

  // Phone OTP session is the only public self-registration identity path.
  const sessionClient = await createClient();
  const {
    data: { user },
  } = await sessionClient.auth.getUser();

  if (!user) {
    return NextResponse.json(
      {
        error:
          "Verify your phone with OTP first, then complete registration.",
      },
      { status: 401, headers },
    );
  }

  const { data: sessionProfile, error: sessionProfileError } = await sessionClient
    .from("profiles")
    .select("role, phone, disabled_at")
    .eq("id", user.id)
    .maybeSingle();
  if (sessionProfileError) {
    return NextResponse.json(
      { error: "Registration service is unavailable." },
      { status: 503, headers },
    );
  }
  if (
    sessionProfile?.disabled_at ||
    (sessionProfile?.role && sessionProfile.role !== "patient")
  ) {
    return NextResponse.json(
      { error: "Patient registration only." },
      { status: 403, headers },
    );
  }

  const sessionPhone = normalizePhone10(user.phone || "");
  const hasVerifiedPhone =
    Boolean(user.phone_confirmed_at) && sessionPhone.length === 10;
  const { data: linkedIdentity, error: linkedIdentityError } = hasVerifiedPhone
    ? { data: null, error: null }
    : await admin
        .from("patients")
        .select("id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();
  if (linkedIdentityError) {
    return NextResponse.json(
      { error: "Registration service is unavailable." },
      { status: 503, headers },
    );
  }
  const isProvisionedPatient =
    sessionProfile?.role === "patient" && Boolean(linkedIdentity);
  if (!hasVerifiedPhone && !isProvisionedPatient) {
    return NextResponse.json(
      { error: "Verify your phone with OTP or use your linked patient login." },
      { status: 401, headers },
    );
  }
  const identityPhone = hasVerifiedPhone
    ? sessionPhone
    : normalizePhone10(sessionProfile?.phone || "");
  if (phone && phone !== identityPhone) {
    return NextResponse.json(
      { error: "Phone must match the number on your verified patient account." },
      { status: 400, headers },
    );
  }
  const regPhone = identityPhone;

  // Ensure profile is patient with phone on file before creating the row.
  const { error: profileError } = await admin.from("profiles").upsert({
    id: user.id,
    role: "patient",
    phone: regPhone ? `+91${regPhone}` : null,
    full_name: fullName,
    email: email || null,
  });
  if (profileError) {
    return NextResponse.json(
      { error: "Registration service is unavailable." },
      { status: 503, headers },
    );
  }

  const { data, error } = await admin.rpc("register_patient_idempotent", {
    p_request_id: requestId,
    p_camp_id: campId,
    p_full_name: fullName,
    p_gender: gender,
    p_age: age,
    p_address: address || null,
    p_phone: regPhone,
    p_email: email || null,
    p_aadhaar_last4: aadhaarLast4 || null,
    p_user_id: user.id,
    p_created_by: null,
    p_camp_day_id: campDayId,
  });

  if (error) {
    return NextResponse.json(
      { error: publicError(error.message) },
      { status: 409, headers },
    );
  }

  const patient = Array.isArray(data) ? data[0] : data;
  if (!patient) {
    return NextResponse.json(
      { error: "Registration failed. Try again or ask the desk." },
      { status: 500, headers },
    );
  }

  return NextResponse.json(
    { patient, mode: "phone_otp" },
    { status: 201, headers },
  );
}
