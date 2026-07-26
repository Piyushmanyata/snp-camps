/**
 * Outbound patient notifications.
 *
 * SMS: MSG91 registration template only (#51). The old generic
 * `SMS_WEBHOOK_URL` path was removed — two SMS mechanisms is one too many;
 * MSG91 is the single provider behind `src/lib/msg91.ts`.
 *
 * WhatsApp remains an optional separate webhook (not used for registration SMS).
 */

import { normalizePhoneE164 } from "@/lib/phone";
import { sensitiveProviderUrl } from "@/lib/provider-url";
import {
  isMsg91Configured,
  sendRegistrationSms,
  type SendRegistrationResult,
} from "@/lib/registration-sms";

export type { SendRegistrationResult };

export async function notifyRegistrationSms(input: {
  phone: string | null | undefined;
  regNo: number;
  dayDate: string;
  venue: string | null | undefined;
  statusUrl: string;
}): Promise<SendRegistrationResult> {
  return sendRegistrationSms(input);
}

/** Optional WhatsApp webhook — not used for DLT registration SMS. */
export async function notifyWhatsApp(payload: {
  phone: string;
  message: string;
  meta?: Record<string, string | number | null | undefined>;
}): Promise<"sent" | "skipped" | "failed"> {
  const phone = normalizePhoneE164(payload.phone);
  const endpoint = process.env.WHATSAPP_WEBHOOK_URL?.trim();
  if (!phone || !endpoint) return "skipped";

  const secret = process.env.NOTIFY_WEBHOOK_SECRET?.trim();
  try {
    const providerUrl = sensitiveProviderUrl(endpoint);
    if (!providerUrl) return "failed";
    const res = await fetch(providerUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({
        phone,
        message: payload.message,
        template: "registration",
        channel: "whatsapp",
        meta: payload.meta ?? {},
      }),
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

export function notifyConfigured(): { sms: boolean; whatsapp: boolean } {
  return {
    sms: isMsg91Configured(),
    whatsapp: Boolean(process.env.WHATSAPP_WEBHOOK_URL?.trim()),
  };
}
