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
 * Staff only. Failures are recorded for admin; response is never needed
 * by the desk UI (client does not block on this).
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
  const { data: row, error } = await supabase
    .from("patients")
    .select(
      "id, reg_no, phone, status_token, camp_day_id, camps(venue), camp_days(day_date)",
    )
    .eq("id", body.patientId)
    .maybeSingle();

  if (error || !row) {
    return NextResponse.json(
      { ok: false, status: "failed", detail: "Patient not found" },
      { status: 404 },
    );
  }

  const camps = row.camps as { venue?: string | null } | { venue?: string | null }[] | null;
  const campDays = row.camp_days as
    | { day_date?: string | null }
    | { day_date?: string | null }[]
    | null;
  const venue = Array.isArray(camps) ? camps[0]?.venue : camps?.venue;
  const dayDate = Array.isArray(campDays)
    ? campDays[0]?.day_date
    : campDays?.day_date;

  if (!dayDate || row.reg_no == null || !row.status_token) {
    return NextResponse.json(
      { ok: false, status: "failed", detail: "Patient missing day or token" },
      { status: 400 },
    );
  }

  const result = await sendRegistrationSms({
    phone: row.phone,
    regNo: Number(row.reg_no),
    dayDate: String(dayDate),
    venue: venue ?? null,
    statusUrl: statusUrlForToken(String(row.status_token)),
  });

  return NextResponse.json({ ok: result.status === "sent", ...result });
}
