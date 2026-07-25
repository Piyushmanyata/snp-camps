/**
 * WhatsApp / SMS notifications — stub until providers are configured.
 *
 * Set one or both:
 *   SMS_WEBHOOK_URL=https://…   (POST JSON)
 *   WHATSAPP_WEBHOOK_URL=https://…
 * Optional: NOTIFY_WEBHOOK_SECRET as Bearer token.
 */

type NotifyPayload = {
  phone: string;
  message: string;
  /** short template key for provider routing */
  template?: "registration";
  meta?: Record<string, string | number | null | undefined>;
};

type NotifyResult = {
  sms: "sent" | "skipped" | "failed";
  whatsapp: "sent" | "skipped" | "failed";
  detail?: string;
};

import { normalizePhoneE164 } from "@/lib/phone";
import { sensitiveProviderUrl } from "@/lib/provider-url";

async function postWebhook(
  url: string | undefined,
  body: Record<string, unknown>,
): Promise<"sent" | "skipped" | "failed"> {
  const endpoint = url?.trim();
  if (!endpoint) return "skipped";

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
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/** Send SMS + WhatsApp when webhooks configured; otherwise no-op (skipped). */
export async function notifyPatient(
  payload: NotifyPayload,
): Promise<NotifyResult> {
  const phone = normalizePhoneE164(payload.phone);
  if (!phone) {
    return {
      sms: "skipped",
      whatsapp: "skipped",
      detail: "No valid phone for notify",
    };
  }

  const body = {
    phone,
    message: payload.message,
    template: payload.template ?? "registration",
    channel: "both" as const,
    meta: payload.meta ?? {},
  };

  const [sms, whatsapp] = await Promise.all([
    postWebhook(process.env.SMS_WEBHOOK_URL, { ...body, channel: "sms" }),
    postWebhook(process.env.WHATSAPP_WEBHOOK_URL, {
      ...body,
      channel: "whatsapp",
    }),
  ]);

  return { sms, whatsapp };
}

export function registrationMessage(regNo: number): string {
  return (
    `SNP Camp: Registered. Reg no #${regNo}. ` +
    `Keep your desk slip: login needs reg no + passcode on the slip. ` +
    `Lost slip? Ask the volunteer desk to reissue.`
  );
}

export function notifyConfigured(): { sms: boolean; whatsapp: boolean } {
  return {
    sms: Boolean(process.env.SMS_WEBHOOK_URL?.trim()),
    whatsapp: Boolean(process.env.WHATSAPP_WEBHOOK_URL?.trim()),
  };
}
