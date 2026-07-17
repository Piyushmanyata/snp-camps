import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { patientAuthEmail } from "@/lib/patient-auth";

/**
 * Create (or reset) a patient login after registration.
 * Uses synthetic email reg{N}@patients.snp.local so patients sign in with reg no + password.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const patientId = String(body.patientId || "").trim();
  const regNo = Number(body.regNo);
  const password = String(body.password || "");
  const fullName = String(body.fullName || "").trim();

  if (!patientId || !Number.isFinite(regNo) || regNo <= 0) {
    return NextResponse.json({ error: "patientId and regNo required" }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 },
    );
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return NextResponse.json(
      { error: "Server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: patient, error: pErr } = await admin
    .from("patients")
    .select("id, reg_no, full_name, user_id")
    .eq("id", patientId)
    .maybeSingle();

  if (pErr || !patient) {
    return NextResponse.json({ error: "Patient not found" }, { status: 404 });
  }
  if (patient.reg_no !== regNo) {
    return NextResponse.json({ error: "Reg no mismatch" }, { status: 400 });
  }

  const email = patientAuthEmail(regNo);
  const name = fullName || patient.full_name || `Patient ${regNo}`;

  // If already linked, update password on that auth user
  if (patient.user_id) {
    const { error: updErr } = await admin.auth.admin.updateUserById(
      patient.user_id,
      { password, email_confirm: true },
    );
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 400 });
    }
    await admin
      .from("profiles")
      .update({ role: "patient", full_name: name, email })
      .eq("id", patient.user_id);
    return NextResponse.json({ ok: true, linked: true });
  }

  // Create new auth user
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, patient_reg_no: regNo },
  });

  if (createErr) {
    // Email already exists — try link by looking up user
    if (/already|registered|exists/i.test(createErr.message)) {
      return NextResponse.json(
        {
          error:
            "A login already exists for this reg no. Use Patient login with your password, or ask admin for a reset.",
        },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: createErr.message }, { status: 400 });
  }

  if (!created.user) {
    return NextResponse.json({ error: "No user created" }, { status: 400 });
  }

  await admin.from("profiles").upsert({
    id: created.user.id,
    role: "patient",
    full_name: name,
    email,
  });

  const { error: linkErr } = await admin
    .from("patients")
    .update({ user_id: created.user.id })
    .eq("id", patientId)
    .is("user_id", null);

  if (linkErr) {
    return NextResponse.json({ error: linkErr.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, userId: created.user.id });
}
