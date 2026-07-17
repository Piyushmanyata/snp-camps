import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { getSessionProfile, isAdmin, readJsonBody } from "@/lib/auth";
import { patientAuthEmail } from "@/lib/patient-auth";
import { patientScanUrl } from "@/lib/qr";
import { generatePatientPassword } from "@/lib/patient-password";
import {
  notifyConfigured,
  notifyPatient,
  registrationMessage,
} from "@/lib/notify";

type Body = {
  patientId?: string;
  regNo?: number | string;
  password?: string;
  fullName?: string;
  /** Return plaintext password once (self-reg first link only). */
  returnCredentials?: boolean;
  /** Send reg+password via SMS/WhatsApp stubs when phone on file. */
  notify?: boolean;
};

/**
 * Create / ensure a patient login after registration.
 * Self-reg: returnCredentials + notify → password once + WhatsApp/SMS stub.
 * QR is for staff scan only — not passwordless patient login.
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
  const returnCredentials = body.returnCredentials === true;
  const doNotify = body.notify === true;
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
    .select("id, reg_no, full_name, user_id, phone")
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
  const loginUrl = patientScanUrl(patientId, origin);
  const configured = notifyConfigured();
  const phoneOnFile = patient.phone;

  async function maybeNotify(password: string) {
    if (!doNotify || !phoneOnFile) {
      return { sms: "skipped" as const, whatsapp: "skipped" as const };
    }
    return notifyPatient({
      phone: phoneOnFile,
      message: registrationMessage(regNo, password),
      template: "registration",
      meta: { reg_no: regNo, patient_id: patientId },
    });
  }

  // Already linked — only same patient session or admin may change password
  if (patient.user_id) {
    if (passwordRaw) {
      const { userId, profile } = await getSessionProfile();
      const allowed =
        userId === patient.user_id || isAdmin(profile?.role);
      if (!allowed) {
        return NextResponse.json(
          {
            error:
              "Login already exists for this patient. Use patient login or ask admin.",
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

      const notify = await maybeNotify(passwordRaw);
      return NextResponse.json({
        ok: true,
        linked: true,
        loginUrl,
        patientId,
        userId: patient.user_id,
        regNo,
        ...(returnCredentials ? { password: passwordRaw } : {}),
        notify,
        notifyConfigured: configured,
      });
    }

    return NextResponse.json({
      ok: true,
      linked: true,
      loginUrl,
      patientId,
      userId: patient.user_id,
      regNo,
      notifyConfigured: configured,
    });
  }

  // First-time account for unlinked registration
  const password = passwordRaw || generatePatientPassword();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, patient_reg_no: regNo },
  });

  if (createErr) {
    if (/already|registered|exists/i.test(createErr.message)) {
      // Auth user exists but patient not linked — link only, no password reissue without auth
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
          regNo,
          // No password — account already existed
          notifyConfigured: configured,
          message:
            "Account already existed. Sign in with your previous password, or use Sign out → show credentials after logging in.",
        });
      }
      return NextResponse.json(
        {
          error:
            "A login already exists for this reg no. Use patient login or ask admin.",
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
    phone: phoneOnFile,
  });

  const { error: linkErr } = await admin
    .from("patients")
    .update({ user_id: created.user.id })
    .eq("id", patientId)
    .is("user_id", null);

  if (linkErr) {
    return NextResponse.json({ error: linkErr.message }, { status: 400 });
  }

  const notify = await maybeNotify(password);

  return NextResponse.json({
    ok: true,
    userId: created.user.id,
    loginUrl,
    patientId,
    regNo,
    ...(returnCredentials ? { password } : {}),
    notify,
    notifyConfigured: configured,
  });
}
