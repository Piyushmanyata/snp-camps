import { NextResponse } from "next/server";
import { loadSessionProfile, readJsonBody } from "@/lib/auth";
import { isStaff } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import {
  isMsg91Configured,
  sendRegistrationSms,
  statusUrlForToken,
} from "@/lib/registration-sms";
import { isPatientUuid } from "@/lib/qr";
import {
  claimSmsDelivery,
  completeSmsDelivery,
  phoneLast4FromRaw,
} from "@/lib/sms-deliveries";

/**
 * Fire-and-forget registration SMS after a successful desk register.
 * Staff only. status_token is read via SECURITY DEFINER RPC (#56).
 * Durable pending row is created at registration (#65); this route claims and sends.
 * Never blocks/fails the desk path that already succeeded.
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

  // If claim fails (already sent), still return non-error for the desk nudge.
  const phoneLast4 = phoneLast4FromRaw(String(row.phone));
  let claim;
  try {
    claim = await claimSmsDelivery(supabase, {
      patientId: body.patientId,
      kind: "registration",
      phoneLast4,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "claim failed";
    return NextResponse.json(
      { ok: false, status: "failed", detail: detail.slice(0, 300) },
      { status: 502 },
    );
  }

  if (!claim) {
    return NextResponse.json({
      ok: true,
      status: "skipped",
      reason: "not_claimed",
    });
  }

  const result = await sendRegistrationSms(
    {
      phone: row.phone,
      regNo: Number(row.reg_no),
      dayDate: String(dayDate),
      venue: row.venue ?? null,
      statusUrl: statusUrlForToken(String(statusToken)),
      // Ledger already claimed above — send without double-claim.
      patientId: null,
    },
    { template: "registration" },
  );

  if (result.status === "sent") {
    await completeSmsDelivery(supabase, {
      deliveryId: claim.deliveryId,
      claimToken: claim.claimToken,
      outcome: "sent",
      providerRequestId: result.requestId ?? null,
    }).catch(() => {});
    return NextResponse.json({ ok: true, status: "sent", requestId: result.requestId });
  }

  if (result.status === "skipped") {
    // Unconfigured mid-flight or no phone — release claim to pending.
    await completeSmsDelivery(supabase, {
      deliveryId: claim.deliveryId,
      claimToken: claim.claimToken,
      outcome: "release",
    }).catch(() => {});
    return NextResponse.json({ ok: true, ...result });
  }

  if (result.status === "ambiguous") {
    await completeSmsDelivery(supabase, {
      deliveryId: claim.deliveryId,
      claimToken: claim.claimToken,
      outcome: "ambiguous",
      lastError: result.detail,
    }).catch(() => {});
    return NextResponse.json({ ok: false, status: "ambiguous", detail: result.detail });
  }

  await completeSmsDelivery(supabase, {
    deliveryId: claim.deliveryId,
    claimToken: claim.claimToken,
    outcome: "failed",
    lastError: result.detail,
  }).catch(() => {});
  return NextResponse.json({ ok: false, status: "failed", detail: result.detail });
}
