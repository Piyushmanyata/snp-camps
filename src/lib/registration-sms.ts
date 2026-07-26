/**
 * Hinglish registration SMS — DLT template + MSG91 dispatch (#51).
 *
 * Template text is a fixed constant. Runtime only fills named slots for
 * length tests and for the MSG91 variables payload — never invents free text.
 */

import { formatCampDaySms } from "@/lib/format-camp-day";
import { sendMsg91TemplateSms } from "@/lib/msg91";
import { normalizePhoneE164 } from "@/lib/phone";

/**
 * Exact DLT body to register with TRAI / MSG91 (Roman Hinglish, GSM-7).
 * Four sequential {#var#} slots: reg, date, venue, link.
 * Date slot uses compact form e.g. "30 Sep 2026" (see formatCampDaySms).
 */
export const REGISTRATION_SMS_DLT_TEMPLATE =
  "SNP Camp: Reg #{#var#}. {#var#} pe aana, {#var#}. Slip rakhein. {#var#}";

/** MSG91 flow variable names, same order as DLT {#var#} slots. */
export const REGISTRATION_SMS_VAR_ORDER = [
  "reg",
  "date",
  "venue",
  "link",
] as const;

/** Venue hard cap so max-length inputs stay in one 160-char GSM-7 segment. */
export const SMS_VENUE_MAX = 35;

/**
 * GSM-7 default alphabet + basic extension markers we never emit.
 * Reject anything outside this set so the whole SMS stays one segment.
 */
const GSM7_RE =
  /^[\n\r !"#%&'()*+,\-./0-9:;<=>?@A-Z_a-z£¥èéùìòÇØøÅåÆæßÉ¤¡¿ÄÖÑÜ§äöñüà]*$/;

export function isGsm7(text: string): boolean {
  return GSM7_RE.test(text);
}

export function assertGsm7(text: string, label = "value"): string {
  if (!isGsm7(text)) {
    throw new Error(`${label} contains non-GSM-7 characters`);
  }
  return text;
}

export function truncateVenueForSms(venue: string): string {
  const cleaned = venue.replace(/\s+/g, " ").trim() || "venue TBA";
  const slice =
    cleaned.length <= SMS_VENUE_MAX
      ? cleaned
      : cleaned.slice(0, SMS_VENUE_MAX);
  // Drop any non-GSM-7 (en-dash, smart quotes) rather than fail the desk.
  let out = "";
  for (const ch of slice) {
    if (isGsm7(ch)) out += ch;
  }
  return out || "venue TBA";
}

export type RegistrationSmsVars = {
  regNo: number;
  dayDate: string;
  venue: string | null | undefined;
  statusUrl: string;
};

/** Fill the fixed template for length tests and admin preview. */
export function fillRegistrationSms(input: RegistrationSmsVars): string {
  const vars = registrationSmsVariables(input);
  let i = 0;
  return REGISTRATION_SMS_DLT_TEMPLATE.replace(/\{#var#\}/g, () => {
    const key = REGISTRATION_SMS_VAR_ORDER[i++];
    return vars[key] ?? "";
  });
}

export function registrationSmsVariables(
  input: RegistrationSmsVars,
): Record<(typeof REGISTRATION_SMS_VAR_ORDER)[number], string> {
  const reg = String(input.regNo);
  assertGsm7(reg, "reg");
  const date = formatCampDaySms(input.dayDate);
  assertGsm7(date, "date");
  const venue = truncateVenueForSms(input.venue || "venue TBA");
  assertGsm7(venue, "venue");
  const link = String(input.statusUrl || "").trim();
  assertGsm7(link, "link");
  return { reg, date, venue, link };
}

/** Realistic maximums used by the segment-length test. */
export function maxLengthRegistrationInputs(): RegistrationSmsVars {
  return {
    regNo: 999999,
    // formatCampDay("2026-09-30") → longest-ish en-IN short form
    dayDate: "2026-09-30",
    venue: "A".repeat(SMS_VENUE_MAX),
    statusUrl: "https://snp-camps.vercel.app/s/" + "a".repeat(32),
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
  template: "registration" | "test";
  detail: string;
  /** Last 4 digits only — never store full phone in the admin log. */
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
  | { status: "skipped"; reason: "no_phone" | "unconfigured" }
  | { status: "failed"; detail: string };

type SendFn = typeof sendMsg91TemplateSms;

/**
 * Send the registration template. Never throws — desk must not care.
 */
export async function sendRegistrationSms(
  input: {
    phone: string | null | undefined;
    regNo: number;
    dayDate: string;
    venue: string | null | undefined;
    statusUrl: string;
  },
  options: { send?: SendFn; template?: "registration" | "test" } = {},
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
  const templateId = process.env.MSG91_TEMPLATE_REGISTRATION!.trim();
  const mobiles = phone.replace(/\D/g, "");
  const phoneLast4 = mobiles.slice(-4);

  let variables: Record<string, string>;
  try {
    variables = registrationSmsVariables({
      regNo: input.regNo,
      dayDate: input.dayDate,
      venue: input.venue,
      statusUrl: input.statusUrl,
    });
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "SMS variable build failed";
    recordSmsFailure({ template, detail, phoneLast4 });
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
      recordSmsFailure({ template, detail: result.detail, phoneLast4 });
      return { status: "failed", detail: result.detail };
    }
    return { status: "sent", requestId: result.requestId };
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "SMS send threw";
    recordSmsFailure({ template, detail, phoneLast4 });
    return { status: "failed", detail };
  }
}

/** Origin for passwordless status links in SMS. */
export function statusUrlForToken(token: string): string {
  const base = (
    process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"
  ).replace(/\/$/, "");
  return `${base}/s/${token}`;
}
