
import { formatCampDaySms } from "@/lib/format-camp-day";
import { sendMsg91TemplateSms } from "@/lib/msg91";
import { normalizePhoneE164 } from "@/lib/phone";
import {
  DEVANAGARI_VENUE_FALLBACK,
  recordSmsFailure,
  SMS_VENUE_MAX,
  truncateVenueForSms,
} from "@/lib/registration-sms";
import { assertSmsSegments } from "@/lib/sms-segments";
import {
  claimSmsDelivery,
  completeSmsDelivery,
  markSmsDispatchStarted,
  phoneLast4FromRaw,
  pruneSmsDeliveries,
  type SmsDeliveryClient,
} from "@/lib/sms-deliveries";

export const REMINDER_SMS_DLT_TEMPLATE =
  "SNP नेत्र शिविर स्मरण: #{#var#}। {#var#} को {#var#} आएं।";

export const REMINDER_SMS_VAR_ORDER = ["reg", "date", "venue"] as const;

export type ReminderSmsVars = {
  regNo: number;
  dayDate: string;
  venue: string | null | undefined;
};

export function fillReminderSms(input: ReminderSmsVars): string {
  const vars = reminderSmsVariables(input);
  let i = 0;
  const text = REMINDER_SMS_DLT_TEMPLATE.replace(/\{#var#\}/g, () => {
    const key = REMINDER_SMS_VAR_ORDER[i++];
    return vars[key] ?? "";
  });
  return assertSmsSegments(text, "reminder");
}

export function reminderSmsVariables(
  input: ReminderSmsVars,
): Record<(typeof REMINDER_SMS_VAR_ORDER)[number], string> {
  const reg = String(input.regNo);
  const date = formatCampDaySms(input.dayDate);
  const venue = truncateVenueForSms(input.venue || DEVANAGARI_VENUE_FALLBACK);
  return { reg, date, venue };
}

export function maxLengthReminderInputs(): ReminderSmsVars {
  return {
    regNo: 999999,
    dayDate: "2026-09-30",
    venue: "क".repeat(SMS_VENUE_MAX),
  };
}

export function isMsg91ReminderConfigured(): boolean {
  return Boolean(
    process.env.MSG91_AUTH_KEY?.trim() &&
      process.env.MSG91_SENDER_ID?.trim() &&
      (process.env.MSG91_DLT_TE_ID_REMINDER?.trim() || process.env.MSG91_TEMPLATE_REMINDER?.trim()),
  );
}

export function kolkataDateIso(
  dayOffset = 0,
  now: Date = new Date(),
): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = fmt.format(now);
  if (dayOffset === 0) return today;
  const base = new Date(`${today}T12:00:00+05:30`);
  base.setTime(base.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  return fmt.format(base);
}

export type ReminderCandidate = {
  id: string;
  regNo: number;
  phone: string | null | undefined;
  queueStatus: string;
  dayDate: string;
  venue: string | null | undefined;
  reminderSmsSentAt?: string | null | undefined;
  reminderDeliveryState?: string | null | undefined;
};

export function isReminderEligible(
  row: ReminderCandidate,
  tomorrowIso: string,
): boolean {
  if (row.queueStatus !== "registered") return false;
  if (row.dayDate !== tomorrowIso) return false;
  if (!row.phone || !normalizePhoneE164(row.phone)) return false;
  const st = row.reminderDeliveryState;
  if (st === "sent" || st === "ambiguous") return false;
  if (st === "sending") return false;
  if (!st && row.reminderSmsSentAt) return false;
  return true;
}

export type SendReminderResult =
  | { status: "sent"; requestId?: string }
  | { status: "skipped"; reason: "no_phone" | "unconfigured" }
  | { status: "failed"; detail: string }
  | { status: "ambiguous"; detail: string };

type SendFn = typeof sendMsg91TemplateSms;

export async function sendReminderSms(
  input: {
    phone: string | null | undefined;
    regNo: number;
    dayDate: string;
    venue: string | null | undefined;
  },
  options: { send?: SendFn } = {},
): Promise<SendReminderResult> {
  const phone = input.phone ? normalizePhoneE164(input.phone) : null;
  if (!phone) {
    return { status: "skipped", reason: "no_phone" };
  }

  if (!isMsg91ReminderConfigured()) {
    return { status: "skipped", reason: "unconfigured" };
  }

  const authKey = process.env.MSG91_AUTH_KEY!.trim();
  const senderId = process.env.MSG91_SENDER_ID!.trim();
  const templateId = (
    process.env.MSG91_DLT_TE_ID_REMINDER || process.env.MSG91_TEMPLATE_REMINDER
  )!.trim();
  const mobiles = phone.replace(/\D/g, "");
  const phoneLast4 = mobiles.slice(-4);

  let variables: Record<string, string>;
  try {
    const smsInput = {
      regNo: input.regNo,
      dayDate: input.dayDate,
      venue: input.venue,
    };
    fillReminderSms(smsInput);
    variables = reminderSmsVariables(smsInput);
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "SMS variable build failed";
    recordSmsFailure({ template: "reminder", detail, phoneLast4 });
    return { status: "failed", detail };
  }

  const send = options.send ?? sendMsg91TemplateSms;
  try {
    const result = await send({
      mobiles,
      templateId,
      senderId,
      authKey,
      variables,
    });
    if (!result.ok) {
      recordSmsFailure({
        template: "reminder",
        detail: result.detail,
        phoneLast4,
      });
      const uncertain =
        result.failureKind === "uncertain" ||
        /timeout|aborted|network|fetch failed/i.test(result.detail);
      return uncertain
        ? { status: "ambiguous", detail: result.detail }
        : { status: "failed", detail: result.detail };
    }
    return { status: "sent", requestId: result.requestId };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "SMS send threw";
    recordSmsFailure({ template: "reminder", detail, phoneLast4 });
    return { status: "ambiguous", detail };
  }
}

export type ReminderJobDeps = {
  listCandidates: () => Promise<ReminderCandidate[]>;
  claimReminder: (
    patientId: string,
    phoneLast4: string | null,
  ) => Promise<{ deliveryId: string; claimToken: string } | null>;
  completeReminder: (input: {
    deliveryId: string;
    claimToken: string;
    outcome: "sent" | "failed" | "ambiguous" | "release";
    providerRequestId?: string | null;
    lastError?: string | null;
  }) => Promise<boolean>;
  startReminder: (claim: {
    deliveryId: string;
    claimToken: string;
  }) => Promise<boolean>;
  send?: SendFn;
  now?: Date;
  preFiltered?: boolean;
  prune?: () => Promise<void>;
};

export type ReminderJobSummary = {
  tomorrow: string;
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  ambiguous: number;
  ok: boolean;
  error?: string;
};

export async function runDayBeforeReminders(
  deps: ReminderJobDeps,
): Promise<ReminderJobSummary> {
  const tomorrow = kolkataDateIso(1, deps.now ?? new Date());
  const summary: ReminderJobSummary = {
    tomorrow,
    considered: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    ambiguous: 0,
    ok: true,
  };

  let rows: ReminderCandidate[];
  try {
    rows = await deps.listCandidates();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "list candidates failed";
    console.error("[reminder-sms] list failed", detail);
    recordSmsFailure({ template: "reminder", detail });
    summary.ok = false;
    summary.error = detail.slice(0, 300);
    return summary;
  }

  for (const row of rows) {
    summary.considered += 1;
    const eligible = deps.preFiltered
      ? row.queueStatus === "registered" &&
        Boolean(row.phone && normalizePhoneE164(row.phone)) &&
        row.reminderDeliveryState !== "sent" &&
        row.reminderDeliveryState !== "ambiguous" &&
        !(
          !row.reminderDeliveryState &&
          Boolean(row.reminderSmsSentAt)
        )
      : isReminderEligible(row, tomorrow);

    if (!eligible) {
      summary.skipped += 1;
      continue;
    }

    const phoneLast4 = phoneLast4FromRaw(row.phone ?? null);
    let claim: { deliveryId: string; claimToken: string } | null = null;
    try {
      claim = await deps.claimReminder(row.id, phoneLast4);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "claim failed";
      recordSmsFailure({ template: "reminder", detail });
      summary.failed += 1;
      continue;
    }
    if (!claim) {
      summary.skipped += 1;
      continue;
    }

    let dispatchMarked = false;
    try {
      dispatchMarked = await deps.startReminder(claim);
    } catch {
      dispatchMarked = false;
    }
    if (!dispatchMarked) {
      await deps.completeReminder({
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        outcome: "release",
      }).catch(() => false);
      summary.failed += 1;
      summary.ok = false;
      summary.error = "SMS dispatch boundary could not be recorded.";
      continue;
    }

    const result = await sendReminderSms(
      {
        phone: row.phone,
        regNo: row.regNo,
        dayDate: row.dayDate,
        venue: row.venue,
      },
      { send: deps.send },
    );

    if (result.status === "sent") {
      try {
        const completed = await deps.completeReminder({
          deliveryId: claim.deliveryId,
          claimToken: claim.claimToken,
          outcome: "sent",
          providerRequestId: result.requestId ?? null,
        });
        if (!completed) {
          summary.ambiguous += 1;
          summary.ok = false;
          summary.error = "Provider accepted an SMS but ledger confirmation failed.";
          continue;
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : "complete sent failed";
        console.error("[reminder-sms] complete sent failed", detail);
        summary.ambiguous += 1;
        summary.ok = false;
        summary.error = "Provider accepted an SMS but ledger confirmation failed.";
        continue;
      }
      summary.sent += 1;
      continue;
    }

    if (result.status === "skipped") {
      try {
        await deps.completeReminder({
          deliveryId: claim.deliveryId,
          claimToken: claim.claimToken,
          outcome: "release",
        });
      } catch {}
      summary.skipped += 1;
      continue;
    }

    if (result.status === "ambiguous") {
      try {
        await deps.completeReminder({
          deliveryId: claim.deliveryId,
          claimToken: claim.claimToken,
          outcome: "ambiguous",
          lastError: result.detail,
        });
      } catch {}
      summary.ambiguous += 1;
      continue;
    }

    try {
      await deps.completeReminder({
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        outcome: "failed",
        lastError: result.detail,
      });
    } catch {}
    summary.failed += 1;
  }

  if (deps.prune) {
    try {
      await deps.prune();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "prune failed";
      console.error("[reminder-sms] prune failed", detail);
    }
  }

  console.info("[reminder-sms] job done", summary);
  return summary;
}

export type ReminderSupabase = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
} & SmsDeliveryClient;

export function createReminderJobStore(
  supabase: ReminderSupabase,
): Pick<
  ReminderJobDeps,
  | "listCandidates"
  | "claimReminder"
  | "completeReminder"
  | "startReminder"
  | "preFiltered"
  | "prune"
> {
  return {
    preFiltered: true,
    async listCandidates() {
      const tomorrow = kolkataDateIso(1);
      const { data, error } = await supabase
        .from("patients")
        .select(
          "id, reg_no, phone, queue_status, reminder_sms_sent_at, camp_days!inner(day_date), camps!inner(venue)",
        )
        .eq("queue_status", "registered")
        .not("phone", "is", null)
        .eq("camp_days.day_date", tomorrow);

      if (error) throw new Error(error.message);

      const rows = (data ?? []) as Array<{
        id: string;
        reg_no: number;
        phone: string | null;
        queue_status: string;
        reminder_sms_sent_at: string | null;
        camp_days: { day_date: string } | { day_date: string }[] | null;
        camps: { venue: string | null } | { venue: string | null }[] | null;
      }>;

      const ids = rows.map((r) => r.id);
      const stateByPatient = new Map();
      if (ids.length > 0) {
        const { data: deliveries, error: dErr } = await supabase
          .from("sms_deliveries")
          .select("patient_id, state")
          .eq("kind", "reminder")
          .in("patient_id", ids);
        if (dErr) throw new Error(dErr.message);
        for (const d of deliveries ?? []) {
          stateByPatient.set(d.patient_id, d.state);
        }
      }

      return rows.map((r) => {
        const day = Array.isArray(r.camp_days) ? r.camp_days[0] : r.camp_days;
        const camp = Array.isArray(r.camps) ? r.camps[0] : r.camps;
        return {
          id: r.id,
          regNo: r.reg_no,
          phone: r.phone,
          queueStatus: r.queue_status,
          dayDate: day?.day_date ?? "",
          venue: camp?.venue ?? null,
          reminderSmsSentAt: r.reminder_sms_sent_at,
          reminderDeliveryState: stateByPatient.get(r.id) ?? null,
        };
      });
    },
    async claimReminder(patientId, phoneLast4) {
      return claimSmsDelivery(supabase, {
        patientId,
        kind: "reminder",
        phoneLast4,
      });
    },
    async completeReminder(input) {
      return completeSmsDelivery(supabase, input);
    },
    async startReminder(claim) {
      return markSmsDispatchStarted(supabase, claim);
    },
    async prune() {
      await pruneSmsDeliveries(supabase);
    },
  };
}

