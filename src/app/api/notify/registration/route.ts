import { NextResponse } from "next/server";
import { loadSessionProfile, readJsonBody } from "@/lib/auth";
import { isStaff } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import {
  sendRegistrationSms,
  statusUrlForToken,
} from "@/lib/registration-sms";
import { isPatientUuid } from "@/lib/qr";

/**
 * Fire-and-forget registration SMS after a successful desk register.
 * Staff only. status_token is read via SECURITY DEFINER RPC (#56) —
 * ordinary authenticated SELECT on status_token is revoked.
 */
export async function POST(req: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId || !isStaff(profile?.role)) {
    return NextResponse.json({ error: "Staff only" }, { status: 403 });
  }

  const body = await readJsonBody<{ patientId?: string }>(req);
  if (!body?.patientId || !isPatientUuid(body.patientId)) {
    return NextResponse.json({ error: "Invalid patient id" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: rows, error } = await supabase.rpc(
    "patient_registration_notify_fields",
    { p_patient_id: body.patientId },
  );

  const row = Array.isArray(rows) ? rows[0] : rows;
  if (error || !row) {
    return NextResponse.json(
      { ok: false, status: "failed", detail: "Patient not found" },
      { status: 404 },
    );
  }

  const dayDate = row.day_date;
  const statusToken = row.status_token;
  if (!dayDate || row.reg_no == null || !statusToken) {
    return NextResponse.json(
      { ok: false, status: "failed", detail: "Patient missing day or token" },
      { status: 400 },
    );
  }

  const result = await sendRegistrationSms({
    phone: row.phone,
    regNo: Number(row.reg_no),
    dayDate: String(dayDate),
    venue: row.venue ?? null,
    statusUrl: statusUrlForToken(String(statusToken)),
  });

  return NextResponse.json({ ok: result.status === "sent", ...result });
}
