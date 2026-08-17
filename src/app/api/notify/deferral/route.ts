import { NextResponse } from "next/server";
import { loadSessionProfile, readJsonBody } from "@/lib/auth";
import { isAdmin, isClinicalOperator } from "@/lib/roles";
import { checkRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import {
  deferralIssueKind,
  deferralServiceLabel,
  isMsg91DeferralConfigured,
  sendDeferralSms,
  type DeferralSmsService,
} from "@/lib/deferral-sms";

const NOTIFY_RATE_LIMIT = {
  scope: "notify-deferral",
  limit: 30,
  windowMs: 60_000,
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isClinicalOperator(profile?.role) && !isAdmin(profile?.role)) {
    return NextResponse.json({ error: "Clinical only" }, { status: 403 });
  }

  const rate = checkRateLimit(req, {
    ...NOTIFY_RATE_LIMIT,
    identifier: userId,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        status: "rate_limited",
        error: "Too many notify requests. Try again shortly.",
      },
      { status: 429, headers: rate.headers },
    );
  }

  const body = await readJsonBody<{ slipId?: string }>(req);
  if (!body?.slipId || !UUID.test(body.slipId)) {
    return NextResponse.json({ error: "Invalid slip id" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("clinical_slip_by_id", {
    p_slip_id: body.slipId,
  });
  if (error || !data) {
    return NextResponse.json(
      { ok: false, status: "failed", error: "Slip not found" },
      { status: 404 },
    );
  }
  const slip = data as {
    service: DeferralSmsService;
    date: string;
    venue: string;
    patient_id: string;
  };
  if (slip.service !== "specs" && slip.service !== "ot") {
    return NextResponse.json({ ok: true, status: "skipped", reason: "not_deferred" });
  }

  if (!isMsg91DeferralConfigured()) {
    return NextResponse.json({
      ok: true,
      status: "skipped",
      reason: "unconfigured",
    });
  }

  const ledger = createServiceRoleClient();
  if (!ledger) {
    return NextResponse.json(
      { ok: false, status: "failed", error: "Service unavailable" },
      { status: 503 },
    );
  }

  const { data: patient, error: patientError } = await ledger
    .from("patients")
    .select("phone")
    .eq("id", slip.patient_id)
    .maybeSingle();
  if (patientError || !patient) {
    return NextResponse.json(
      { ok: false, status: "failed", error: "Patient not found" },
      { status: 404 },
    );
  }
  if (!patient.phone) {
    return NextResponse.json({ ok: true, status: "skipped", reason: "no_phone" });
  }

  const result = await sendDeferralSms(
    {
      phone: patient.phone,
      service: deferralServiceLabel(slip.service),
      dayDate: String(slip.date),
      venue: slip.venue ?? null,
      patientId: slip.patient_id,
      kind: deferralIssueKind(slip.service),
    },
    { ledger },
  );

  if (result.status === "sent") {
    return NextResponse.json({
      ok: true,
      status: "sent",
      requestId: result.requestId,
    });
  }
  if (result.status === "skipped") {
    return NextResponse.json({ ok: true, ...result });
  }
  if (result.status === "ambiguous") {
    console.error("[notify/deferral] ambiguous SMS", {
      detail: result.detail,
      slipId: body.slipId,
    });
    return NextResponse.json(
      {
        ok: false,
        status: "ambiguous",
        error: "SMS delivery is uncertain. Check the ledger.",
      },
      { status: 502 },
    );
  }
  console.error("[notify/deferral] SMS failed", {
    detail: result.detail,
    slipId: body.slipId,
  });
  return NextResponse.json(
    { ok: false, status: "failed", error: "SMS could not be sent. Try again later." },
    { status: 502 },
  );
}
