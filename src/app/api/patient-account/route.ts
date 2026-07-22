import { after, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { getSessionProfile, isAdmin, isStaff, readJsonBody } from "@/lib/auth";
import { patientAuthEmail } from "@/lib/patient-auth";
import { parseRegistrationNumber, patientScanUrl } from "@/lib/qr";
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
  password?: string;
  /** Return plaintext password once to the authenticated patient or admin. */
  returnCredentials?: boolean;
  /** Send reg+password via SMS/WhatsApp stubs when phone on file. */
  notify?: boolean;
  /** Staff-only: provision a login for a desk-created registration. */
  adminProvision?: boolean;
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
  const regNo = parseRegistrationNumber(body.regNo);
  const passwordRaw = body.password != null ? String(body.password) : "";
  const returnCredentials = body.returnCredentials === true;
  const doNotify = body.notify === true;
  const adminProvisionRequested = body.adminProvision === true;
  const rate = checkRateLimit(req, {
    scope: "patient-account",
    identifier: `${patientId}:${regNo ?? "invalid"}`,
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
    regNo === null
  ) {
    return NextResponse.json(
      { error: "patientId and regNo required" },
      { status: 400 },
    );
  }
  const safeRegNo = regNo;

  if (passwordRaw && passwordRaw.length < 4) {
    return NextResponse.json(
      { error: "Password must be at least 4 characters" },
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
      "id, reg_no, full_name, user_id, phone, account_provisioning_token",
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

  function queueNotification(loginRegNo = safeRegNo) {
    if (!doNotify || !phoneOnFile) {
      return false;
    }
    after(async () => {
      await notifyPatient({
        phone: phoneOnFile,
        message: registrationMessage(loginRegNo),
        template: "registration",
        meta: { reg_no: loginRegNo, patient_id: patientId },
      });
    });
    return true;
  }

  // Already linked — only the patient session or staff may provision credentials.
  if (patient.user_id) {
    const { userId, profile } = await getSessionProfile();
    const allowed = userId === patient.user_id || isStaff(profile?.role);
    if (!allowed) {
      return NextResponse.json(
        { error: "Login already exists for this patient." },
        { status: 403 },
      );
    }

    if (!passwordRaw && !returnCredentials) {
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

    const { data: userAuth, error: userAuthError } =
      await admin.auth.admin.getUserById(patient.user_id);
    if (userAuthError || !userAuth.user) {
      return NextResponse.json(
        { error: "Patient login could not be loaded." },
        { status: 500 },
      );
    }
    const currentEmail = userAuth?.user?.email;
    const isOtpUser = Boolean(userAuth?.user?.phone);

    let emailToUpdate = email;
    let regNoToReturn = regNo;
    if (isOtpUser && currentEmail && currentEmail.startsWith("reg")) {
      emailToUpdate = currentEmail;
      const match = currentEmail.match(/^reg(\d+)@/);
      if (match && match[1]) {
        regNoToReturn = Number(match[1]);
      }
    }

    const password = passwordRaw || generatePatientPassword();
    const { error: updErr } = await admin.auth.admin.updateUserById(
      patient.user_id,
      { email: emailToUpdate, password, email_confirm: true },
    );
    if (updErr) {
      return NextResponse.json({ error: "Patient login could not be updated." }, { status: 400 });
    }
    const { error: profileError } = await admin
      .from("profiles")
      .update({ role: "patient", full_name: name, email: emailToUpdate })
      .eq("id", patient.user_id);
    if (profileError) {
      return NextResponse.json({ error: "Patient profile could not be updated." }, { status: 500 });
    }

    const notificationQueued = queueNotification(regNoToReturn);
    return NextResponse.json({
      ok: true,
      linked: true,
      scanUrl,
      patientId,
      userId: patient.user_id,
      regNo: regNoToReturn,
      ...(returnCredentials ? { password } : {}),
      notificationQueued,
      notifyConfigured: configured,
    });
  }

  // Unlinked rows are desk-created.
  const { profile } = await getSessionProfile();
  if (!adminProvisionRequested || !isStaff(profile?.role)) {
    return NextResponse.json({ error: "Staff authorization required" }, { status: 403 });
  }
  if (!returnCredentials) {
    return NextResponse.json(
      { error: "One-time credentials must be returned for admin provisioning." },
      { status: 400 },
    );
  }

  // Atomically reserve this row before crossing the database/Auth transaction
  // boundary. Only one admin request may create or link its Auth user.
  const originalProvisioningToken = patient.account_provisioning_token;
  const reservationToken = randomBytes(24).toString("hex");
  let reservation = admin
    .from("patients")
    .update({ account_provisioning_token: reservationToken })
    .eq("id", patientId)
    .is("user_id", null);
  reservation = originalProvisioningToken
    ? reservation.eq("account_provisioning_token", originalProvisioningToken)
    : reservation.is("account_provisioning_token", null);

  const { data: reserved, error: reserveError } = await reservation
    .select("id")
    .maybeSingle();
  if (reserveError || !reserved) {
    return NextResponse.json(
      { error: "Patient login is already being provisioned. Refresh and retry." },
      { status: 409 },
    );
  }

  async function restoreProvisioningReservation() {
    if (!admin) return;
    await admin
      .from("patients")
      .update({ account_provisioning_token: originalProvisioningToken })
      .eq("id", patientId)
      .is("user_id", null)
      .eq("account_provisioning_token", reservationToken);
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
          await restoreProvisioningReservation();
          return NextResponse.json(
            { error: "Patient login could not be provisioned. Try again." },
            { status: 500 },
          );
        }
        const { data: linked, error: linkErr } = await admin
          .from("patients")
          .update({
            user_id: existingProfile.id,
            account_provisioning_token: null,
          })
          .eq("id", patientId)
          .is("user_id", null)
          .eq("account_provisioning_token", reservationToken)
          .select("id")
          .maybeSingle();
        if (linkErr || !linked) {
          await restoreProvisioningReservation();
          return NextResponse.json(
            { error: "Patient login was already provisioned" },
            { status: 409 },
          );
        }
        const { error: resetError } = await admin.auth.admin.updateUserById(
          existingProfile.id,
          { password, email_confirm: true },
        );
        if (resetError) {
          await admin
            .from("patients")
            .update({
              user_id: null,
              account_provisioning_token: originalProvisioningToken,
            })
            .eq("id", patientId)
            .eq("user_id", existingProfile.id);
          return NextResponse.json(
            { error: "Patient login could not be reset." },
            { status: 500 },
          );
        }
        return NextResponse.json({
          ok: true,
          linked: true,
          scanUrl,
          patientId,
          userId: existingProfile.id,
          regNo,
          password,
          notifyConfigured: configured,
          message:
            "Patient login linked and reset. Share the one-time password securely.",
        });
      }
      await restoreProvisioningReservation();
      return NextResponse.json(
        {
          error:
            "A login already exists for this reg no. Use patient login or ask admin.",
        },
        { status: 400 },
      );
    }
    await restoreProvisioningReservation();
    return NextResponse.json(
      { error: "Patient login could not be created. Try again." },
      { status: 400 },
    );
  }

  if (!created.user) {
    await restoreProvisioningReservation();
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
    await restoreProvisioningReservation();
    return NextResponse.json(
      { error: "Patient login could not be provisioned. Try again." },
      { status: 500 },
    );
  }

  const { data: linked, error: linkErr } = await admin
    .from("patients")
    .update({
      user_id: created.user.id,
      account_provisioning_token: null,
    })
    .eq("id", patientId)
    .is("user_id", null)
    .eq("account_provisioning_token", reservationToken)
    .select("id")
    .maybeSingle();

  if (linkErr || !linked) {
    await admin.auth.admin.deleteUser(created.user.id);
    await restoreProvisioningReservation();
    return NextResponse.json(
      { error: linkErr?.message || "Patient login was already provisioned" },
      { status: linkErr ? 400 : 409 },
    );
  }

  const notificationQueued = queueNotification(regNo);

  return NextResponse.json({
    ok: true,
    userId: created.user.id,
    scanUrl,
    patientId,
    regNo,
    ...(returnCredentials ? { password } : {}),
    notificationQueued,
    notifyConfigured: configured,
  });
}
