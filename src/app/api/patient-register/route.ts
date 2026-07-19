import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { normalizePhoneE164 } from "@/lib/phone";

type Body = {
  /** Aadhaar path (kept for later integration). */
  verificationToken?: string;
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
    return "A valid phone number is required for registration.";
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

  const verificationToken = String(body.verificationToken || "").trim();
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
  const age =
    body.age == null
      ? null
      : typeof body.age === "number"
        ? body.age
        : Number.NaN;

  const rate = checkRateLimit(request, {
    scope: "patient-register",
    identifier: verificationToken || phone || "missing",
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

  if (!UUID.test(campId) || !UUID.test(campDayId)) {
    return NextResponse.json(
      { error: "A valid camp day is required." },
      { status: 400, headers },
    );
  }
  if (!fullName || fullName.length > 120) {
    return NextResponse.json(
      { error: "Full name is required and must be under 120 characters." },
      { status: 400, headers },
    );
  }
  if (age !== null && (!Number.isInteger(age) || age < 0 || age > 149)) {
    return NextResponse.json(
      { error: "Age must be a whole number from 0 to 149." },
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

  // —— Path A: Aadhaar verified token (legacy / future integration) ——
  if (/^[0-9a-f]{64}$/i.test(verificationToken)) {
    if (phone && phone.length !== 10) {
      return NextResponse.json(
        { error: "Enter a valid 10-digit mobile number." },
        { status: 400, headers },
      );
    }
    const { data, error } = await admin.rpc("register_verified_patient", {
      p_verification_token: verificationToken,
      p_camp_id: campId,
      p_full_name: fullName,
      p_gender: gender,
      p_age: age,
      p_address: address || null,
      p_phone: phone || null,
      p_email: email || null,
      p_camp_day_id: campDayId,
    });

    if (error) {
      return NextResponse.json(
        { error: publicError(error.message) },
        { status: /verification/i.test(error.message) ? 403 : 409, headers },
      );
    }

    const patient = Array.isArray(data) ? data[0] : data;
    if (!patient) {
      return NextResponse.json(
        { error: "Registration failed. Try again or ask the desk." },
        { status: 500, headers },
      );
    }
    return NextResponse.json({ patient, mode: "aadhaar" }, { status: 201, headers });
  }

  // —— Path B: Phone OTP session (primary) ——
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

  const { data: sessionProfile } = await sessionClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (sessionProfile?.role && sessionProfile.role !== "patient") {
    return NextResponse.json(
      { error: "Patient registration only." },
      { status: 403, headers },
    );
  }

  const sessionPhone = normalizePhone10(user.phone || "");
  const regPhone = phone.length === 10 ? phone : sessionPhone;
  if (regPhone.length !== 10) {
    return NextResponse.json(
      { error: "A verified 10-digit mobile number is required." },
      { status: 400, headers },
    );
  }
  if (sessionPhone && sessionPhone !== regPhone) {
    return NextResponse.json(
      { error: "Phone must match the number you verified with OTP." },
      { status: 400, headers },
    );
  }

  // Ensure profile is patient with phone on file before creating the row.
  const { error: profileError } = await admin.from("profiles").upsert({
    id: user.id,
    role: "patient",
    phone: `+91${regPhone}`,
    full_name: fullName,
    email: email || null,
  });
  if (profileError) {
    return NextResponse.json(
      { error: "Registration service is unavailable." },
      { status: 503, headers },
    );
  }

  const { data, error } = await admin.rpc("register_patient", {
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
