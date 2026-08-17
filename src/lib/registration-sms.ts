
import { formatCampDaySms } from "@/lib/format-camp-day";
import { assertSmsSegments } from "@/lib/sms-segments";
import { sendMsg91TemplateSms } from "@/lib/msg91";
import { normalizePhoneE164 } from "@/lib/phone";
import {
  claimSmsDelivery,
  completeSmsDelivery,
  markSmsDispatchStarted,
  phoneLast4FromRaw,
  type SmsDeliveryClient,
} from "@/lib/sms-deliveries";

export const REGISTRATION_SMS_DLT_TEMPLATE =
  "SNP नेत्र शिविर: पंजीकरण #{#var#}। {#var#} को {#var#} आएं। पर्ची रखें।";

export const REGISTRATION_SMS_VAR_ORDER = ["reg", "date", "venue"] as const;

export const SMS_VENUE_MAX = 35;
export const DEVANAGARI_VENUE_FALLBACK = "स्थान बाद में";

const graphemes = new Intl.Segmenter("hi", { granularity: "grapheme" });

export function truncateVenueForSms(venue: string): string {
  const cleaned = venue.replace(/\s+/g, " ").trim() || DEVANAGARI_VENUE_FALLBACK;
  let out = "";
  for (const { segment } of graphemes.segment(cleaned)) {
    if (out.length + segment.length > SMS_VENUE_MAX) break;
    out += segment;
  }
  return out.trim() || DEVANAGARI_VENUE_FALLBACK;
}

export type RegistrationSmsVars = {
  regNo: number;
  dayDate: string;
  venue: string | null | undefined;
};

export function fillRegistrationSms(input: RegistrationSmsVars): string {
  const vars = registrationSmsVariables(input);
  let i = 0;
  const text = REGISTRATION_SMS_DLT_TEMPLATE.replace(/\{#var#\}/g, () => {
    const key = REGISTRATION_SMS_VAR_ORDER[i++];
    return vars[key] ?? "";
  });
  return assertSmsSegments(text, "registration");
}

export function registrationSmsVariables(
  input: RegistrationSmsVars,
): Record<(typeof REGISTRATION_SMS_VAR_ORDER)[number], string> {
  const reg = String(input.regNo);
  const date = formatCampDaySms(input.dayDate);
  const venue = truncateVenueForSms(input.venue || DEVANAGARI_VENUE_FALLBACK);
  return { reg, date, venue };
}

export function maxLengthRegistrationInputs(): RegistrationSmsVars {
  return {
    regNo: 999999,
    dayDate: "2026-09-30",
    venue: "क".repeat(SMS_VENUE_MAX),
  };
}

export function isMsg91Configured(): boolean {
  return Boolean(
    process.env.MSG91_AUTH_KEY?.trim() &&
      process.env.MSG91_SENDER_ID?.trim() &&
      process.env.MSG91_TEMPLATE_REGISTRATION?.trim(),
  );
}

export type SmsFailureRecord = {
  at: string;
  template: "registration" | "test" | "reminder" | "deferral";
  detail: string;
  phoneLast4?: string;
};

const MAX_FAILURES = 50;
const failureLog: SmsFailureRecord[] = [];

export function recordSmsFailure(
  entry: Omit<SmsFailureRecord, "at"> & { at?: string },
): void {
  failureLog.push({
    at: entry.at ?? new Date().toISOString(),
    template: entry.template,
    detail: entry.detail.slice(0, 300),
    phoneLast4: entry.phoneLast4,
  });
  while (failureLog.length > MAX_FAILURES) failureLog.shift();
  console.error("[sms-failure]", {
    template: entry.template,
    detail: entry.detail.slice(0, 300),
    phoneLast4: entry.phoneLast4,
  });
}

export function listSmsFailures(): SmsFailureRecord[] {
  return failureLog.slice();
}

export function resetSmsFailuresForTests(): void {
  failureLog.length = 0;
}

export type SendRegistrationResult =
  | { status: "sent"; requestId?: string }
  | {
      status: "skipped";
      reason: "no_phone" | "unconfigured" | "already_handled" | "not_claimed";
    }
  | { status: "failed"; detail: string }
  | { status: "ambiguous"; detail: string };

type SendFn = typeof sendMsg91TemplateSms;

export async function sendRegistrationSms(
  input: {
    phone: string | null | undefined;
    regNo: number;
    dayDate: string;
    venue: string | null | undefined;
    patientId?: string | null;
  },
  options: {
    send?: SendFn;
    template?: "registration" | "test";
    ledger?: SmsDeliveryClient | null;
  } = {},
): Promise<SendRegistrationResult> {
  const template = options.template ?? "registration";
  const phone = input.phone ? normalizePhoneE164(input.phone) : null;
  if (!phone) {
    return { status: "skipped", reason: "no_phone" };
  }

  if (!isMsg91Configured()) {
    return { status: "skipped", reason: "unconfigured" };
  }

  const authKey = process.env.MSG91_AUTH_KEY!.trim();
  const senderId = process.env.MSG91_SENDER_ID!.trim();
  const templateId = (
    process.env.MSG91_DLT_TE_ID_REGISTRATION || process.env.MSG91_TEMPLATE_REGISTRATION
  )!.trim();
  const mobiles = phone.replace(/\D/g, "");
  const phoneLast4 = mobiles.slice(-4);

  const useLedger =
    template === "registration" &&
    Boolean(options.ledger && input.patientId);

  let claim: { deliveryId: string; claimToken: string } | null = null;
  if (useLedger && options.ledger && input.patientId) {
    try {
      claim = await claimSmsDelivery(options.ledger, {
        patientId: input.patientId,
        kind: "registration",
        phoneLast4: phoneLast4FromRaw(phone) ?? phoneLast4,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "SMS claim failed";
      recordSmsFailure({ template, detail, phoneLast4 });
      return { status: "failed", detail };
    }
    if (!claim) {
      return { status: "skipped", reason: "not_claimed" };
    }
  }

  let variables: Record<string, string>;
  try {
    const smsInput = {
      regNo: input.regNo,
      dayDate: input.dayDate,
      venue: input.venue,
    };
    fillRegistrationSms(smsInput);
    variables = registrationSmsVariables(smsInput);
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "SMS variable build failed";
    recordSmsFailure({ template, detail, phoneLast4 });
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
      recordSmsFailure({ template, detail, phoneLast4 });
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
      recordSmsFailure({ template, detail: result.detail, phoneLast4 });
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
        recordSmsFailure({ template, detail, phoneLast4 });
        return { status: "ambiguous", detail };
      }
    }
    return { status: "sent", requestId: result.requestId };
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "SMS send threw";
    recordSmsFailure({ template, detail, phoneLast4 });
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


