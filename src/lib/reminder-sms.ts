/**
 * Day-before camp reminder SMS — DLT template + MSG91 + daily job (#52).
 *
 * Reuses the single MSG91 adapter. Separate template ID env var.
 * Never throws out of the job path.
 */

import { formatCampDaySms } from "@/lib/format-camp-day";
import { sendMsg91TemplateSms } from "@/lib/msg91";
import { normalizePhoneE164 } from "@/lib/phone";
import {
  assertGsm7,
  isGsm7,
  recordSmsFailure,
  SMS_VENUE_MAX,
  truncateVenueForSms,
} from "@/lib/registration-sms";

/**
 * Exact DLT body for the day-before reminder (Roman Hinglish, GSM-7).
 * Three sequential {#var#} slots: reg, date, venue.
 * No status link — useful when the patient cannot open a URL.
 */
export const REMINDER_SMS_DLT_TEMPLATE =
  "SNP Camp: Kal aana. Reg #{#var#}. {#var#} pe aana, {#var#}. Slip rakhein.";

export const REMINDER_SMS_VAR_ORDER = ["reg", "date", "venue"] as const;

export type ReminderSmsVars = {
  regNo: number;
  dayDate: string;
  venue: string | null | undefined;
};

/** Fill the fixed template for length tests and previews. */
export function fillReminderSms(input: ReminderSmsVars): string {
  const vars = reminderSmsVariables(input);
  let i = 0;
  return REMINDER_SMS_DLT_TEMPLATE.replace(/\{#var#\}/g, () => {
    const key = REMINDER_SMS_VAR_ORDER[i++];
    return vars[key] ?? "";
  });
}

export function reminderSmsVariables(
  input: ReminderSmsVars,
): Record<(typeof REMINDER_SMS_VAR_ORDER)[number], string> {
  const reg = String(input.regNo);
  assertGsm7(reg, "reg");
  const date = formatCampDaySms(input.dayDate);
  assertGsm7(date, "date");
  const venue = truncateVenueForSms(input.venue || "venue TBA");
  assertGsm7(venue, "venue");
  return { reg, date, venue };
}

export function maxLengthReminderInputs(): ReminderSmsVars {
  return {
    regNo: 999999,
    dayDate: "2026-09-30",
    venue: "A".repeat(SMS_VENUE_MAX),
  };
}

export function isMsg91ReminderConfigured(): boolean {
  return Boolean(
    process.env.MSG91_AUTH_KEY?.trim() &&
      process.env.MSG91_SENDER_ID?.trim() &&
      process.env.MSG91_TEMPLATE_REMINDER?.trim(),
  );
}

/**
 * Calendar date `YYYY-MM-DD` in Asia/Kolkata for `now + dayOffset`.
 * dayOffset 0 = today, 1 = tomorrow.
 */
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
  // en-CA yields YYYY-MM-DD
  const today = fmt.format(now);
  if (dayOffset === 0) return today;
  // Anchor noon IST so DST-less +05:30 date math cannot slip.
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
  reminderSmsSentAt: string | null | undefined;
};

/** Pure filter used by tests and as documentation of eligibility. */
export function isReminderEligible(
  row: ReminderCandidate,
  tomorrowIso: string,
): boolean {
  if (row.queueStatus !== "registered") return false;
  if (row.reminderSmsSentAt) return false;
  if (row.dayDate !== tomorrowIso) return false;
  if (!row.phone || !normalizePhoneE164(row.phone)) return false;
  return true;
}

export type SendReminderResult =
  | { status: "sent"; requestId?: string }
  | { status: "skipped"; reason: "no_phone" | "unconfigured" }
  | { status: "failed"; detail: string };

type SendFn = typeof sendMsg91TemplateSms;

/**
 * Send one reminder SMS. Never throws.
 */
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
  const templateId = process.env.MSG91_TEMPLATE_REMINDER!.trim();
  const mobiles = phone.replace(/\D/g, "");
  const phoneLast4 = mobiles.slice(-4);

  let variables: Record<string, string>;
  try {
    variables = reminderSmsVariables({
      regNo: input.regNo,
      dayDate: input.dayDate,
      venue: input.venue,
    });
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
      return { status: "failed", detail: result.detail };
    }
    return { status: "sent", requestId: result.requestId };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "SMS send threw";
    recordSmsFailure({ template: "reminder", detail, phoneLast4 });
    return { status: "failed", detail };
  }
}

export type ReminderJobDeps = {
  /** Candidates already filtered to tomorrow / registered / not-yet-sent, or raw list. */
  listCandidates: () => Promise<ReminderCandidate[]>;
  /**
   * Claim send-once: set reminder_sms_sent_at only when still null.
   * Returns true if this runner won the claim.
   */
  claimSent: (patientId: string) => Promise<boolean>;
  /** Clear claim when provider failed after claim (allows later retry). */
  clearSent?: (patientId: string) => Promise<void>;
  send?: SendFn;
  now?: Date;
  /** When true, listCandidates already filtered — only re-check phone/status. */
  preFiltered?: boolean;
};

export type ReminderJobSummary = {
  tomorrow: string;
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Job always completes; errors are counted, not thrown. */
  ok: true;
};

/**
 * Run the day-before reminder pass. Never throws.
 * Claim-before-send so a double cron run cannot text the same patient twice.
 */
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
    ok: true,
  };

  let rows: ReminderCandidate[];
  try {
    rows = await deps.listCandidates();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "list candidates failed";
    console.error("[reminder-sms] list failed", detail);
    recordSmsFailure({ template: "reminder", detail });
    return summary;
  }

  for (const row of rows) {
    summary.considered += 1;
    const eligible = deps.preFiltered
      ? row.queueStatus === "registered" &&
        !row.reminderSmsSentAt &&
        Boolean(row.phone && normalizePhoneE164(row.phone))
      : isReminderEligible(row, tomorrow);

    if (!eligible) {
      summary.skipped += 1;
      continue;
    }

    let claimed = false;
    try {
      claimed = await deps.claimSent(row.id);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "claim failed";
      recordSmsFailure({ template: "reminder", detail });
      summary.failed += 1;
      continue;
    }
    if (!claimed) {
      summary.skipped += 1;
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
      summary.sent += 1;
      continue;
    }

    if (result.status === "skipped") {
      summary.skipped += 1;
    } else {
      summary.failed += 1;
    }

    // Release claim so a later cron can retry after outage / skip.
    if (deps.clearSent) {
      try {
        await deps.clearSent(row.id);
      } catch (err) {
        const detail =
          err instanceof Error ? err.message : "clear claim failed";
        console.error("[reminder-sms] clear claim failed", row.id, detail);
      }
    }
  }

  console.info("[reminder-sms] job done", summary);
  return summary;
}

/** Minimal PostgREST-shaped client used by the cron (service role). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReminderSupabase = { from: (table: string) => any };

/** Supabase-backed candidate list + claim helpers for the cron route. */
export function createReminderJobStore(
  supabase: ReminderSupabase,
): Pick<
  ReminderJobDeps,
  "listCandidates" | "claimSent" | "clearSent" | "preFiltered"
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
        .is("reminder_sms_sent_at", null)
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
        };
      });
    },
    async claimSent(patientId: string) {
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from("patients")
        .update({ reminder_sms_sent_at: now })
        .eq("id", patientId)
        .is("reminder_sms_sent_at", null)
        .select("id")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return Boolean(data?.id);
    },
    async clearSent(patientId: string) {
      const { error } = await supabase
        .from("patients")
        .update({ reminder_sms_sent_at: null })
        .eq("id", patientId);
      if (error) throw new Error(error.message);
    },
  };
}

// re-export for tests that only need GSM check on filled body
export { isGsm7 };
