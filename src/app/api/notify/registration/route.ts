import { NextResponse } from "next/server";
import { loadSessionProfile, readJsonBody } from "@/lib/auth";
import { isStaff } from "@/lib/roles";
import { checkRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import {
  isMsg91Configured,
  sendRegistrationSms,
  statusUrlForToken,
} from "@/lib/registration-sms";
import { isPatientUuid } from "@/lib/qr";

/**
 * Fire-and-forget registration SMS after a successful desk register.
 * Staff only. status_token is read via SECURITY DEFINER RPC (#56).
 * Durable pending row is created at registration (#65); this route claims and sends.
 * Never blocks/fails the desk path that already succeeded.
 */

const NOTIFY_RATE_LIMIT = {
  scope: "notify-registration",
  limit: 30,
  windowMs: 60_000,
};

export async function POST(req: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isStaff(profile?.role)) {
    return NextResponse.json({ error: "Staff only" }, { status: 403 });
  }

  const rate = checkRateLimit(req, {
    ...NOTIFY_RATE_LIMIT,
    identifier: userId,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, status: "rate_limited", error: "Too many notify requests. Try again shortly." },
      { status: 429, headers: rate.headers },
    );
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
      { ok: false, status: "failed", error: "Patient not found" },
      { status: 404 },
    );
  }

  const dayDate = row.day_date;
  const statusToken = row.status_token;
  if (!dayDate || row.reg_no == null || !statusToken) {
    return NextResponse.json(
      { ok: false, status: "failed", error: "Patient missing day or token" },
      { status: 400 },
    );
  }

  if (!row.phone) {
    return NextResponse.json({ ok: true, status: "skipped", reason: "no_phone" });
  }

  if (!isMsg91Configured()) {
    // Leave durable pending for when config appears; do not fail registration.
    return NextResponse.json({
      ok: true,
      status: "skipped",
      reason: "unconfigured",
    });
  }

  const result = await sendRegistrationSms(
    {
      phone: row.phone,
      regNo: Number(row.reg_no),
      dayDate: String(dayDate),
      venue: row.venue ?? null,
      statusUrl: statusUrlForToken(String(statusToken)),
      patientId: body.patientId,
    },
    { template: "registration", ledger: supabase },
  );

  if (result.status === "sent") {
    return NextResponse.json({ ok: true, status: "sent", requestId: result.requestId });
  }

  if (result.status === "skipped") {
    return NextResponse.json({ ok: true, ...result });
  }

  // Never return raw provider error text to the client.
  if (result.status === "ambiguous") {
    console.error("[notify/registration] ambiguous SMS", {
      detail: result.detail,
      patientId: body.patientId,
    });
    return NextResponse.json(
      { ok: false, status: "ambiguous", error: "SMS delivery is uncertain. Check the ledger." },
      { status: 502 },
    );
  }

  console.error("[notify/registration] SMS failed", {
    detail: result.detail,
    patientId: body.patientId,
  });
  return NextResponse.json(
    { ok: false, status: "failed", error: "SMS could not be sent. Try again later." },
    { status: 502 },
  );
}
