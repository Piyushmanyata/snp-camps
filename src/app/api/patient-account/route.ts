import { after, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { isStaff, loadSessionProfile, readJsonBody } from "@/lib/auth";
import { patientAuthEmail } from "@/lib/patient-auth";
import { parseRegistrationNumber, patientScanUrl } from "@/lib/qr";
import {
  isPasswordLongEnough,
  MIN_PASSWORD_LENGTH,
} from "@/lib/patient-password";
import {
  issuePatientPasscode,
  provisionPatientAccount,
  type PatientAccountRow,
} from "@/lib/patient-account-ops";
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
  /** Return plaintext passcode once to the authenticated patient or Staff. */
  returnCredentials?: boolean;
  /** Send reg details via SMS/WhatsApp stubs when phone on file. */
  notify?: boolean;
  /**
   * Staff-only: ensure Auth user exists and patient.user_id is linked.
   * Returns no secret. Pair with returnCredentials for desk issue.
   */
  adminProvision?: boolean;
};

/**
 * Patient login lifecycle after registration (ADR 0001, issue #17).
 *
 * - Provision (adminProvision): Auth user + link. Idempotent. No secret.
 * - Issue/reissue (returnCredentials / password): set Auth password, stamp
 *   passcode_issued_at, return plaintext once to Staff or the patient self.
 *
 * Doctors are Camp crew, not Staff — 403 on both operations.
 * Never deletes an Auth user.
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

  if (passwordRaw && !isPasswordLongEnough(passwordRaw)) {
    return NextResponse.json(
      {
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      },
      { status: 400 },
    );
  }

  const adminClient = createServiceRoleClient();
  if (!adminClient) {
    return NextResponse.json(
      { error: "Patient account service is unavailable" },
      { status: 500 },
    );
  }
  const admin = adminClient;

  const { data: patientRaw, error: pErr } = await admin
    .from("patients")
    .select("id, reg_no, full_name, user_id, phone, passcode_issued_at")
    .eq("id", patientId)
    .maybeSingle();

  if (pErr || !patientRaw) {
    return NextResponse.json({ error: "Patient not found" }, { status: 404 });
  }

  let patient = patientRaw as PatientAccountRow;
  if (patient.reg_no !== regNo) {
    return NextResponse.json({ error: "Reg no mismatch" }, { status: 400 });
  }

  const email = patientAuthEmail(regNo);
  const name = patient.full_name || `Patient ${regNo}`;
  const scanUrl = patientScanUrl(patientId, process.env.NEXT_PUBLIC_SITE_URL);
  const configured = notifyConfigured();
  const phoneOnFile = patient.phone;
  const { userId: sessionUserId, profile } = await loadSessionProfile();

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

  // --- Provision (Staff only) ---
  if (adminProvisionRequested) {
    if (!isStaff(profile?.role)) {
      return NextResponse.json(
        { error: "Staff authorization required" },
        { status: 403 },
      );
    }

    const provisioned = await provisionPatientAccount(admin, patient, {
      email,
      name,
      regNo: safeRegNo,
    });
    if (!provisioned.ok) {
      return NextResponse.json(
        { error: provisioned.error },
        { status: provisioned.status },
      );
    }

    patient = { ...patient, user_id: provisioned.userId };

    // Provision alone: no secret in the response.
    if (!returnCredentials && !passwordRaw) {
      return NextResponse.json({
        ok: true,
        linked: true,
        scanUrl,
        patientId,
        userId: provisioned.userId,
        regNo: safeRegNo,
        notifyConfigured: configured,
      });
    }
  }

  // --- Issue / reissue / patient self-reset ---
  if (returnCredentials || passwordRaw) {
    if (!patient.user_id) {
      // Unlinked without adminProvision: Staff must provision first.
      if (!isStaff(profile?.role)) {
        return NextResponse.json(
          { error: "Staff authorization required" },
          { status: 403 },
        );
      }
      return NextResponse.json(
        {
          error:
            "Patient login is not provisioned yet. Provision the account first.",
        },
        { status: 400 },
      );
    }

    const allowed =
      sessionUserId === patient.user_id || isStaff(profile?.role);
    if (!allowed) {
      return NextResponse.json(
        { error: "Login already exists for this patient." },
        { status: 403 },
      );
    }

    const issued = await issuePatientPasscode(admin, patient, {
      email,
      name,
      regNo: safeRegNo,
      password: passwordRaw || undefined,
    });
    if (!issued.ok) {
      return NextResponse.json(
        { error: issued.error },
        { status: issued.status },
      );
    }

    const notificationQueued = queueNotification(issued.regNo);
    return NextResponse.json({
      ok: true,
      linked: true,
      scanUrl,
      patientId,
      userId: issued.userId,
      regNo: issued.regNo,
      ...(returnCredentials ? { password: issued.password } : {}),
      notificationQueued,
      notifyConfigured: configured,
    });
  }

  // Status / no-op path: already linked, no password change requested.
  if (patient.user_id) {
    const allowed =
      sessionUserId === patient.user_id || isStaff(profile?.role);
    if (!allowed) {
      return NextResponse.json(
        { error: "Login already exists for this patient." },
        { status: 403 },
      );
    }
    return NextResponse.json({
      ok: true,
      linked: true,
      scanUrl,
      patientId,
      userId: patient.user_id,
      regNo: safeRegNo,
      notifyConfigured: configured,
    });
  }

  // Unlinked, no provision flag.
  return NextResponse.json(
    { error: "Staff authorization required" },
    { status: 403 },
  );
}
