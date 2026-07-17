import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { getSessionProfile, isAdmin, readJsonBody } from "@/lib/auth";
import { patientAuthEmail } from "@/lib/patient-auth";

type Body = {
  patientId?: string;
  regNo?: number | string;
  password?: string;
  fullName?: string;
};

/**
 * Create a patient login after registration (reg no + password).
 * First-time setup is allowed for unlinked patients (desk/self-reg flow).
 * Password change on an already-linked account requires that patient session or admin.
 */
export async function POST(req: Request) {
  const body = await readJsonBody<Body>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patientId = String(body.patientId || "").trim();
  const regNo = Number(body.regNo);
  const password = String(body.password || "");
  const fullName = String(body.fullName || "").trim();

  if (!patientId || !Number.isFinite(regNo) || regNo <= 0) {
    return NextResponse.json(
      { error: "patientId and regNo required" },
      { status: 400 },
    );
  }
  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

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

  // Already linked — only the same patient session or an admin may reset password
  if (patient.user_id) {
    const { userId, profile } = await getSessionProfile();
    const allowed =
      userId === patient.user_id || isAdmin(profile?.role);
    if (!allowed) {
      return NextResponse.json(
        {
          error:
            "Login already exists for this patient. Sign in to change password, or ask admin.",
        },
        { status: 403 },
      );
    }

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

  // First-time account for unlinked registration
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, patient_reg_no: regNo },
  });

  if (createErr) {
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
