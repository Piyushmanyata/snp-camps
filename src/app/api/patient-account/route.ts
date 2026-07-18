import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
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
import { checkRateLimit } from "@/lib/rate-limit";

type Body = {
  patientId?: string;
  regNo?: number | string;
  claimToken?: string;
  password?: string;
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
  const claimToken = String(body.claimToken || "").trim();
  const passwordRaw = body.password != null ? String(body.password) : "";
  const returnCredentials = body.returnCredentials === true;
  const doNotify = body.notify === true;
  const rate = checkRateLimit(req, {
    scope: "patient-account",
    identifier: `${patientId}:${regNo}`,
    limit: 12,
    windowMs: 10 * 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many account attempts. Try again later." },
      { status: 429, headers: rate.headers },
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      patientId,
    ) ||
    !Number.isInteger(regNo) ||
    regNo <= 0
  ) {
    return NextResponse.json(
      { error: "patientId and regNo required" },
      { status: 400 },
    );
  }

  if (passwordRaw && passwordRaw.length < 12) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Patient account service is unavailable" },
      { status: 500 },
    );
  }

  const { data: patient, error: pErr } = await admin
    .from("patients")
    .select(
      "id, reg_no, full_name, user_id, phone, account_claim_token, account_claim_expires_at",
    )
    .eq("id", patientId)
    .maybeSingle();

  if (pErr || !patient) {
    return NextResponse.json({ error: "Patient not found" }, { status: 404 });
  }
  if (patient.reg_no !== regNo) {
    return NextResponse.json({ error: "Reg no mismatch" }, { status: 400 });
  }

  const email = patientAuthEmail(regNo);
  const name = patient.full_name || `Patient ${regNo}`;
  // Staff-scan QR only — not a patient login link
  const scanUrl = patientScanUrl(patientId, process.env.NEXT_PUBLIC_SITE_URL);
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
        scanUrl,
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
      scanUrl,
      patientId,
      userId: patient.user_id,
      regNo,
      notifyConfigured: configured,
    });
  }

  // First-time account for unlinked registration
  if (
    !/^[0-9a-f]{48}$/i.test(claimToken) ||
    patient.account_claim_token !== claimToken ||
    !patient.account_claim_expires_at ||
    new Date(patient.account_claim_expires_at).getTime() <= Date.now()
  ) {
    return NextResponse.json(
      { error: "Registration claim expired or invalid" },
      { status: 403 },
    );
  }

  // Atomically reserve the single-use claim before touching Supabase Auth.
  // This prevents two concurrent requests from creating/linking/deleting each
  // other's user across the database/Auth transaction boundary.
  const reservationToken = randomBytes(24).toString("hex");
  const { data: reserved, error: reserveError } = await admin
    .from("patients")
    .update({ account_claim_token: reservationToken })
    .eq("id", patientId)
    .is("user_id", null)
    .eq("account_claim_token", claimToken)
    .gt("account_claim_expires_at", new Date().toISOString())
    .select("id")
    .maybeSingle();
  if (reserveError || !reserved) {
    return NextResponse.json(
      { error: "Registration claim expired or was already used" },
      { status: 409 },
    );
  }

  async function restoreClaim() {
    if (!admin) return;
    await admin
      .from("patients")
      .update({ account_claim_token: claimToken })
      .eq("id", patientId)
      .is("user_id", null)
      .eq("account_claim_token", reservationToken);
  }

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
        .select("id, role")
        .eq("email", email)
        .maybeSingle();
      if (existingProfile?.id && existingProfile.role === "patient") {
        const { error: existingProfileError } = await admin
          .from("profiles")
          .upsert({
          id: existingProfile.id,
          role: "patient",
          full_name: name,
          email,
        });
        if (existingProfileError) {
          await restoreClaim();
          return NextResponse.json(
            { error: "Patient login could not be provisioned. Try again." },
            { status: 500 },
          );
        }
        const { data: linked, error: linkErr } = await admin
          .from("patients")
          .update({
            user_id: existingProfile.id,
            account_claim_token: null,
            account_claim_expires_at: null,
          })
          .eq("id", patientId)
          .is("user_id", null)
          .eq("account_claim_token", reservationToken)
          .select("id")
          .maybeSingle();
        if (linkErr || !linked) {
          await restoreClaim();
          return NextResponse.json(
            { error: "Registration claim was already used" },
            { status: 409 },
          );
        }
        return NextResponse.json({
          ok: true,
          linked: true,
          scanUrl,
          patientId,
          userId: existingProfile.id,
          regNo,
          // No password — account already existed
          notifyConfigured: configured,
          message:
            "Account already existed. Sign in with your previous password, or use Sign out → show credentials after logging in.",
        });
      }
      await restoreClaim();
      return NextResponse.json(
        {
          error:
            "A login already exists for this reg no. Use patient login or ask admin.",
        },
        { status: 400 },
      );
    }
    await restoreClaim();
    return NextResponse.json(
      { error: "Patient login could not be created. Try again." },
      { status: 400 },
    );
  }

  if (!created.user) {
    await restoreClaim();
    return NextResponse.json({ error: "No user created" }, { status: 400 });
  }

  const { error: profileError } = await admin.from("profiles").upsert({
    id: created.user.id,
    role: "patient",
    full_name: name,
    email,
    phone: phoneOnFile,
  });
  if (profileError) {
    await admin.auth.admin.deleteUser(created.user.id);
    await restoreClaim();
    return NextResponse.json(
      { error: "Patient login could not be provisioned. Try again." },
      { status: 500 },
    );
  }

  const { data: linked, error: linkErr } = await admin
    .from("patients")
    .update({
      user_id: created.user.id,
      account_claim_token: null,
      account_claim_expires_at: null,
    })
    .eq("id", patientId)
    .is("user_id", null)
    .eq("account_claim_token", reservationToken)
    .select("id")
    .maybeSingle();

  if (linkErr || !linked) {
    await admin.auth.admin.deleteUser(created.user.id);
    await restoreClaim();
    return NextResponse.json(
      { error: linkErr?.message || "Registration claim was already used" },
      { status: linkErr ? 400 : 409 },
    );
  }

  const notify = await maybeNotify(password);

  return NextResponse.json({
    ok: true,
    userId: created.user.id,
    scanUrl,
    patientId,
    regNo,
    ...(returnCredentials ? { password } : {}),
    notify,
    notifyConfigured: configured,
  });
}
