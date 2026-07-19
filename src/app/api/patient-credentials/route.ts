import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { getSessionProfile } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { generatePatientPassword } from "@/lib/patient-password";
import {
  credentialsMessage,
  notifyConfigured,
  notifyPatient,
  type NotifyResult,
} from "@/lib/notify";
import { patientAuthEmail } from "@/lib/patient-auth";

/**
 * Issue (or re-issue) patient reg no + password.
 * Used after self-registration and on logout so the patient can log back in.
 * Password is returned once in the response; also sent via SMS/WhatsApp stubs.
 */
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { ...NO_STORE, ...headers },
  });
}

export async function POST(req: Request) {
  const { userId, profile } = await getSessionProfile();
  if (!userId) {
    return json({ error: "Not signed in" }, 401);
  }
  if (profile?.role && profile.role !== "patient") {
    return json({ error: "Patient accounts only" }, 403);
  }

  const rate = checkRateLimit(req, {
    scope: "patient-credentials",
    identifier: userId,
    limit: 3,
    windowMs: 10 * 60_000,
  });
  if (!rate.allowed) {
    return json(
      { error: "Too many credential resets. Try again later." },
      429,
      rate.headers,
    );
  }

  const admin = createServiceRoleClient();
  if (!admin) {
    return json({ error: "Patient account service is unavailable" }, 500);
  }

  const { data: patient, error: pErr } = await admin
    .from("patients")
    .select("id, reg_no, full_name, phone, user_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pErr || !patient) {
    return json({ error: "No registration linked to this login." }, 404);
  }

  const password = generatePatientPassword();
  const email = patientAuthEmail(patient.reg_no);

  const { data: userAuth } = await admin.auth.admin.getUserById(userId);
  const currentEmail = userAuth?.user?.email;
  const isOtpUser = Boolean(userAuth?.user?.phone);

  let emailToUpdate = email;
  let regNoToReturn = patient.reg_no;
  if (isOtpUser && currentEmail && currentEmail.startsWith("reg")) {
    emailToUpdate = currentEmail;
    const match = currentEmail.match(/^reg(\d+)@/);
    if (match && match[1]) {
      regNoToReturn = Number(match[1]);
    }
  }

  const { error: updErr } = await admin.auth.admin.updateUserById(userId, {
    email: emailToUpdate,
    password,
    email_confirm: true,
  });
  if (updErr) {
    return json({ error: "Could not issue new credentials." }, 400);
  }

  await admin
    .from("profiles")
    .update({
      role: "patient",
      full_name: patient.full_name,
      email: emailToUpdate,
      phone: patient.phone,
    })
    .eq("id", userId);

  let notify: NotifyResult = { sms: "skipped", whatsapp: "skipped" };
  if (patient.phone) {
    notify = await notifyPatient({
      phone: patient.phone,
      message: credentialsMessage(regNoToReturn, password),
      template: "credentials",
      meta: { reg_no: regNoToReturn, patient_id: patient.id },
    });
  }

  const configured = notifyConfigured();

  return json({
    ok: true,
    regNo: regNoToReturn,
    password,
    fullName: patient.full_name,
    phone: patient.phone,
    notify,
    notifyConfigured: configured,
  });
}
