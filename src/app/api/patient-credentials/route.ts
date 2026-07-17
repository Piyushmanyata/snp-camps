import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { getSessionProfile } from "@/lib/auth";
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
export async function POST() {
  const { userId, profile } = await getSessionProfile();
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (profile?.role && profile.role !== "patient") {
    return NextResponse.json(
      { error: "Patient accounts only" },
      { status: 403 },
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
    .select("id, reg_no, full_name, phone, user_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pErr || !patient) {
    return NextResponse.json(
      { error: "No registration linked to this login." },
      { status: 404 },
    );
  }

  const password = generatePatientPassword();
  const email = patientAuthEmail(patient.reg_no);

  const { error: updErr } = await admin.auth.admin.updateUserById(userId, {
    password,
    email_confirm: true,
  });
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 400 });
  }

  await admin
    .from("profiles")
    .update({
      role: "patient",
      full_name: patient.full_name,
      email,
      phone: patient.phone,
    })
    .eq("id", userId);

  let notify: NotifyResult = { sms: "skipped", whatsapp: "skipped" };
  if (patient.phone) {
    notify = await notifyPatient({
      phone: patient.phone,
      message: credentialsMessage(patient.reg_no, password),
      template: "credentials",
      meta: { reg_no: patient.reg_no, patient_id: patient.id },
    });
  }

  const configured = notifyConfigured();

  return NextResponse.json({
    ok: true,
    regNo: patient.reg_no,
    password,
    fullName: patient.full_name,
    phone: patient.phone,
    notify,
    notifyConfigured: configured,
  });
}
