import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { getSessionProfile, isAdmin, readJsonBody } from "@/lib/auth";
import { patientAuthEmail } from "@/lib/patient-auth";
import { patientLoginUrl } from "@/lib/patient-qr";

type Body = {
  patientId?: string;
  regNo?: number | string;
  password?: string;
  fullName?: string;
};

/**
 * Create / ensure a patient login after registration.
 * Password is optional — desk/self-reg uses QR magic login (random password).
 * Password change on an already-linked account requires that patient session or admin.
 */
export async function POST(req: Request) {
  const body = await readJsonBody<Body>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patientId = String(body.patientId || "").trim();
  const regNo = Number(body.regNo);
  const passwordRaw = body.password != null ? String(body.password) : "";
  const fullName = String(body.fullName || "").trim();
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ||
    req.headers.get("origin") ||
    undefined;

  if (!patientId || !Number.isFinite(regNo) || regNo <= 0) {
    return NextResponse.json(
      { error: "patientId and regNo required" },
      { status: 400 },
    );
  }

  // Optional password (legacy / admin reset). Empty → auto random for QR login.
  if (passwordRaw && passwordRaw.length < 6) {
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
  const loginUrl = patientLoginUrl(patientId, origin);

  // Already linked — only the same patient session or an admin may set password
  if (patient.user_id) {
    if (passwordRaw) {
      const { userId, profile } = await getSessionProfile();
      const allowed =
        userId === patient.user_id || isAdmin(profile?.role);
      if (!allowed) {
        return NextResponse.json(
          {
            error:
              "Login already exists for this patient. Scan the QR to sign in, or ask admin.",
          },
          { status: 403 },
        );
      }

      const { error: updErr } = await admin.auth.admin.updateUserById(
        patient.user_id,
        { password: passwordRaw, email_confirm: true },
      );
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 400 });
      }
      await admin
        .from("profiles")
        .update({ role: "patient", full_name: name, email })
        .eq("id", patient.user_id);
    }

    return NextResponse.json({
      ok: true,
      linked: true,
      loginUrl,
      patientId,
    });
  }

  // First-time account for unlinked registration
  const password = passwordRaw || randomBytes(24).toString("base64url");
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, patient_reg_no: regNo },
  });

  if (createErr) {
    if (/already|registered|exists/i.test(createErr.message)) {
      // Account exists but patient not linked — resolve via profiles.email
      const { data: existingProfile } = await admin
        .from("profiles")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      if (existingProfile?.id) {
        await admin.from("profiles").upsert({
          id: existingProfile.id,
          role: "patient",
          full_name: name,
          email,
        });
        const { error: linkErr } = await admin
          .from("patients")
          .update({ user_id: existingProfile.id })
          .eq("id", patientId)
          .is("user_id", null);
        if (linkErr) {
          return NextResponse.json({ error: linkErr.message }, { status: 400 });
        }
        return NextResponse.json({
          ok: true,
          linked: true,
          loginUrl,
          patientId,
          userId: existingProfile.id,
        });
      }
      return NextResponse.json(
        {
          error:
            "A login already exists for this reg no. Scan your QR, or ask admin.",
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

  return NextResponse.json({
    ok: true,
    userId: created.user.id,
    loginUrl,
    patientId,
  });
}
