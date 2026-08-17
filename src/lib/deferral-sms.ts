import { formatCampDaySms } from "@/lib/format-camp-day";
import { sendMsg91TemplateSms } from "@/lib/msg91";
import { normalizePhoneE164 } from "@/lib/phone";
import {
  DEVANAGARI_VENUE_FALLBACK,
  recordSmsFailure,
  truncateVenueForSms,
} from "@/lib/registration-sms";
import { kolkataDateIso } from "@/lib/reminder-sms";
import { assertSmsSegments } from "@/lib/sms-segments";
import {
  claimSmsDelivery,
  completeSmsDelivery,
  markSmsDispatchStarted,
  phoneLast4FromRaw,
  type SmsDeliveryClient,
  type SmsDeliveryKind,
} from "@/lib/sms-deliveries";

export const DEFERRAL_SMS_DLT_TEMPLATE =
  "SNP नेत्र शिविर: {#var#} {#var#} को {#var#}। पर्ची साथ लाएं।";

export const DEFERRAL_SMS_VAR_ORDER = ["service", "date", "venue"] as const;

export const DEFERRAL_SERVICE_SPECS = "चश्मा";
export const DEFERRAL_SERVICE_OT = "ऑपरेशन";

export type DeferralSmsService = "specs" | "ot";

export type DeferralDeliveryKind = Extract<
  SmsDeliveryKind,
  | "spectacles_deferral"
  | "surgery_deferral"
  | "spectacles_deferral_t1"
  | "surgery_deferral_t1"
>;

export function deferralIssueKind(service: DeferralSmsService): DeferralDeliveryKind {
  return service === "ot" ? "surgery_deferral" : "spectacles_deferral";
}

export function deferralT1Kind(service: DeferralSmsService): DeferralDeliveryKind {
  return service === "ot" ? "surgery_deferral_t1" : "spectacles_deferral_t1";
}

export function deferralServiceLabel(service: DeferralSmsService): string {
  return service === "ot" ? DEFERRAL_SERVICE_OT : DEFERRAL_SERVICE_SPECS;
}

export type DeferralSmsVars = {
  service: string;
  dayDate: string;
  venue: string | null | undefined;
};

export function fillDeferralSms(input: DeferralSmsVars): string {
  const vars = deferralSmsVariables(input);
  let i = 0;
  const text = DEFERRAL_SMS_DLT_TEMPLATE.replace(/\{#var#\}/g, () => {
    const key = DEFERRAL_SMS_VAR_ORDER[i++];
    return vars[key] ?? "";
  });
  return assertSmsSegments(text, "deferral");
}

export function deferralSmsVariables(
  input: DeferralSmsVars,
): Record<(typeof DEFERRAL_SMS_VAR_ORDER)[number], string> {
  return {
    service: input.service,
    date: formatCampDaySms(input.dayDate),
    venue: truncateVenueForSms(input.venue || DEVANAGARI_VENUE_FALLBACK),
  };
}

export function isMsg91DeferralConfigured(): boolean {
  return Boolean(
    process.env.MSG91_AUTH_KEY?.trim() &&
      process.env.MSG91_SENDER_ID?.trim() &&
      process.env.MSG91_TEMPLATE_DEFERRAL?.trim(),
  );
}

type SendFn = typeof sendMsg91TemplateSms;

export type SendDeferralResult =
  | { status: "sent"; requestId?: string }
  | { status: "skipped"; reason: "no_phone" | "unconfigured" | "not_claimed" }
  | { status: "failed"; detail: string }
  | { status: "ambiguous"; detail: string };

export async function sendDeferralSms(
  input: {
    phone: string | null | undefined;
    service: string;
    dayDate: string;
    venue: string | null | undefined;
    patientId?: string | null;
    kind: DeferralDeliveryKind;
  },
  options: {
    send?: SendFn;
    ledger?: SmsDeliveryClient | null;
  } = {},
): Promise<SendDeferralResult> {
  const phone = input.phone ? normalizePhoneE164(input.phone) : null;
  if (!phone) {
    return { status: "skipped", reason: "no_phone" };
  }

  if (!isMsg91DeferralConfigured()) {
    return { status: "skipped", reason: "unconfigured" };
  }

  const authKey = process.env.MSG91_AUTH_KEY!.trim();
  const senderId = process.env.MSG91_SENDER_ID!.trim();
  const templateId = process.env.MSG91_TEMPLATE_DEFERRAL!.trim();
  const mobiles = phone.replace(/\D/g, "");
  const phoneLast4 = mobiles.slice(-4);

  if (!options.ledger || !input.patientId) {
    return { status: "skipped", reason: "not_claimed" };
  }

  let claim: { deliveryId: string; claimToken: string } | null = null;
  try {
    claim = await claimSmsDelivery(options.ledger, {
      patientId: input.patientId,
      kind: input.kind,
      phoneLast4: phoneLast4FromRaw(phone) ?? phoneLast4,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "SMS claim failed";
    recordSmsFailure({ template: "deferral", detail, phoneLast4 });
    return { status: "failed", detail };
  }
  if (!claim) {
    return { status: "skipped", reason: "not_claimed" };
  }

  let variables: Record<string, string>;
  try {
    const smsInput = {
      service: input.service,
      dayDate: input.dayDate,
      venue: input.venue,
    };
    fillDeferralSms(smsInput);
    variables = deferralSmsVariables(smsInput);
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "SMS variable build failed";
    recordSmsFailure({ template: "deferral", detail, phoneLast4 });
    if (claim && options.ledger) {
      await completeSmsDelivery(options.ledger, {
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        outcome: "failed",
        lastError: detail,
      }).catch(() => {});
    }
    return { status: "failed", detail };
  }

  const send = options.send ?? sendMsg91TemplateSms;
  if (claim && options.ledger) {
    let dispatchMarked = false;
    try {
      dispatchMarked = await markSmsDispatchStarted(options.ledger, claim);
    } catch {
      dispatchMarked = false;
    }
    if (!dispatchMarked) {
      await completeSmsDelivery(options.ledger, {
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        outcome: "release",
      }).catch(() => false);
      const detail = "SMS dispatch could not be started safely.";
      recordSmsFailure({ template: "deferral", detail, phoneLast4 });
      return { status: "failed", detail };
    }
  }

  try {
    const result = await send({
      mobiles,
      templateId,
      senderId,
      authKey,
      variables,
    });
    if (!result.ok) {
      const uncertain =
        result.failureKind === "uncertain" ||
        /timeout|aborted|network|fetch failed/i.test(result.detail);
      const outcome = uncertain ? "ambiguous" : "failed";
      recordSmsFailure({ template: "deferral", detail: result.detail, phoneLast4 });
      if (claim && options.ledger) {
        await completeSmsDelivery(options.ledger, {
          deliveryId: claim.deliveryId,
          claimToken: claim.claimToken,
          outcome,
          lastError: result.detail,
        }).catch(() => {});
      }
      return uncertain
        ? { status: "ambiguous", detail: result.detail }
        : { status: "failed", detail: result.detail };
    }
    if (claim && options.ledger) {
      const completed = await completeSmsDelivery(options.ledger, {
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        outcome: "sent",
        providerRequestId: result.requestId ?? null,
      }).catch(() => false);
      if (!completed) {
        const detail =
          "Provider accepted the SMS but ledger confirmation is pending.";
        recordSmsFailure({ template: "deferral", detail, phoneLast4 });
        return { status: "ambiguous", detail };
      }
    }
    return { status: "sent", requestId: result.requestId };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "SMS send threw";
    recordSmsFailure({ template: "deferral", detail, phoneLast4 });
    if (claim && options.ledger) {
      await completeSmsDelivery(options.ledger, {
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        outcome: "ambiguous",
        lastError: detail,
      }).catch(() => {});
    }
    return { status: "ambiguous", detail };
  }
}

export type DeferralJobSummary = {
  tomorrow: string;
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  ambiguous: number;
  ok: boolean;
  error?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DeferralStore = SmsDeliveryClient & { from: (table: string) => any };

export async function runDayBeforeDeferralSms(
  client: DeferralStore,
  options: { send?: SendFn; now?: Date } = {},
): Promise<DeferralJobSummary> {
  const tomorrow = kolkataDateIso(1, options.now ?? new Date());
  const summary: DeferralJobSummary = {
    tomorrow,
    considered: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    ambiguous: 0,
    ok: true,
  };
  try {
    const { data: slips, error } = await client
      .from("deferred_slips")
      .select("id, service, date_snapshot, venue_snapshot, item_id")
      .eq("status", "active")
      .eq("date_snapshot", tomorrow);
    if (error) throw new Error(error.message);
    const rows = (slips ?? []) as Array<{
      id: string;
      service: string;
      date_snapshot: string;
      venue_snapshot: string;
      item_id: string;
    }>;
    summary.considered = rows.length;
    if (rows.length === 0) return summary;

    const itemIds = rows.map((s) => s.item_id);
    const { data: items, error: itemErr } = await client
      .from("fulfilment_items")
      .select("id, transcription_id")
      .in("id", itemIds);
    if (itemErr) throw new Error(itemErr.message);
    const itemById = new Map(
      ((items ?? []) as Array<{ id: string; transcription_id: string }>).map(
        (row) => [String(row.id), String(row.transcription_id)],
      ),
    );
    const tIds = [...new Set([...itemById.values()])];
    const { data: transcriptions, error: tErr } = await client
      .from("prescription_transcriptions")
      .select("id, patient_id")
      .in("id", tIds);
    if (tErr) throw new Error(tErr.message);
    const patientByTranscription = new Map(
      ((transcriptions ?? []) as Array<{ id: string; patient_id: string }>).map(
        (row) => [String(row.id), String(row.patient_id)],
      ),
    );
    const pIds = [...new Set([...patientByTranscription.values()])];
    const { data: patients, error: pErr } = await client
      .from("patients")
      .select("id, phone, reg_no")
      .in("id", pIds);
    if (pErr) throw new Error(pErr.message);
    const patientById = new Map(
      (
        (patients ?? []) as Array<{
          id: string;
          phone: string | null;
          reg_no: number;
        }>
      ).map((row) => [
        String(row.id),
        {
          phone: row.phone ?? null,
          regNo: Number(row.reg_no),
        },
      ]),
    );

    for (const slip of rows) {
      const service: DeferralSmsService = slip.service === "ot" ? "ot" : "specs";
      const transcriptionId = itemById.get(slip.item_id);
      const patientId = transcriptionId
        ? patientByTranscription.get(transcriptionId)
        : undefined;
      const patient = patientId ? patientById.get(patientId) : undefined;
      const result = await sendDeferralSms(
        {
          phone: patient?.phone,
          service: deferralServiceLabel(service),
          dayDate: slip.date_snapshot,
          venue: slip.venue_snapshot,
          patientId,
          kind: deferralT1Kind(service),
        },
        { send: options.send, ledger: client },
      );
      if (result.status === "sent") summary.sent += 1;
      else if (result.status === "skipped") summary.skipped += 1;
      else if (result.status === "ambiguous") summary.ambiguous += 1;
      else summary.failed += 1;
    }
    return summary;
  } catch (err) {
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : "deferral job failed";
    return summary;
  }
}
