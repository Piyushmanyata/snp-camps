import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { createServiceRoleClient } from "@/lib/supabase/admin";

type Body = {
  verificationToken?: string;
  campId?: string;
  campDayId?: string;
  fullName?: string;
  gender?: string | null;
  age?: number | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
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
    return "Aadhaar verification expired. Verify again.";
  }
  if (/active camp|invalid camp day/i.test(message)) {
    return "The selected camp or day is no longer available.";
  }
  return "Registration failed. Try again or ask the desk.";
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
  const phone = String(body.phone || "").replace(/\D/g, "").slice(-10);
  const gender = ["M", "F", "O"].includes(String(body.gender))
    ? String(body.gender)
    : null;
  const age = body.age == null ? null : Number(body.age);

  const rate = checkRateLimit(request, {
    scope: "patient-register",
    identifier: verificationToken || "missing-token",
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

  if (
    !/^[0-9a-f]{64}$/i.test(verificationToken) ||
    !UUID.test(campId) ||
    !UUID.test(campDayId)
  ) {
    return NextResponse.json(
      { error: "Aadhaar verification and a valid camp day are required." },
      { status: 400, headers },
    );
  }
  if (!fullName || fullName.length > 120) {
    return NextResponse.json(
      { error: "Full name is required and must be under 120 characters." },
      { status: 400, headers },
    );
  }
  if (
    age !== null &&
    (!Number.isInteger(age) || age < 0 || age > 149)
  ) {
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
  if (phone && phone.length !== 10) {
    return NextResponse.json(
      { error: "Enter a valid 10-digit mobile number." },
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

  return NextResponse.json({ patient }, { status: 201, headers });
}
