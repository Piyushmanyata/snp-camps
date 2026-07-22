import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { readJsonBody } from "@/lib/auth";
import { patientAuthEmail } from "@/lib/patient-auth";
import { DEFAULT_PATIENT_PASSWORD } from "@/lib/patient-password";
import { parseRegistrationNumber } from "@/lib/qr";
import { checkRateLimit } from "@/lib/rate-limit";

type Body = {
  regNo?: number | string;
};

export async function POST(req: Request) {
  const body = await readJsonBody<Body>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const regNo = parseRegistrationNumber(body.regNo);
  if (regNo === null) {
    return NextResponse.json(
      { error: "Enter a valid registration number (e.g. 1001)." },
      { status: 400 },
    );
  }

  const rate = checkRateLimit(req, {
    scope: "patient-login",
    identifier: String(regNo),
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429, headers: rate.headers },
    );
  }

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Login service is unavailable." },
      { status: 503 },
    );
  }

  const { data: patient, error: patientErr } = await admin
    .from("patients")
    .select("id, reg_no, full_name, user_id, phone")
    .eq("reg_no", regNo)
    .maybeSingle();

  if (patientErr || !patient) {
    return NextResponse.json(
      { error: "Patient not found. Check your registration number." },
      { status: 404 },
    );
  }

  const email = patientAuthEmail(regNo);
  const name = patient.full_name || `Patient ${regNo}`;

  let userId = patient.user_id;

  if (userId) {
    await admin.auth.admin.updateUserById(userId, {
      password: DEFAULT_PATIENT_PASSWORD,
      email_confirm: true,
    });
  } else {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: DEFAULT_PATIENT_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: name, patient_reg_no: regNo },
    });

    if (createErr) {
      const { data: existingProfile } = await admin
        .from("profiles")
        .select("id")
        .eq("email", email)
        .maybeSingle();

      if (existingProfile?.id) {
        userId = existingProfile.id;
        await admin.auth.admin.updateUserById(userId, {
          password: DEFAULT_PATIENT_PASSWORD,
          email_confirm: true,
        });
      } else {
        return NextResponse.json(
          { error: "Could not provision login session." },
          { status: 500 },
        );
      }
    } else if (created.user) {
      userId = created.user.id;
    }

    if (userId) {
      await admin.from("profiles").upsert({
        id: userId,
        role: "patient",
        full_name: name,
        email,
        phone: patient.phone || null,
      });

      await admin
        .from("patients")
        .update({ user_id: userId })
        .eq("id", patient.id);
    }
  }

  return NextResponse.json({
    ok: true,
    email,
    password: DEFAULT_PATIENT_PASSWORD,
    regNo: patient.reg_no,
  });
}
