/**
 * WhatsApp / SMS notifications — stub until providers are configured.
 *
 * Set one or both:
 *   SMS_WEBHOOK_URL=https://…   (POST JSON)
 *   WHATSAPP_WEBHOOK_URL=https://…
 * Optional: NOTIFY_WEBHOOK_SECRET as Bearer token.
 */

export type NotifyChannel = "sms" | "whatsapp";

export type NotifyPayload = {
  phone: string;
  message: string;
  /** short template key for provider routing */
  template?: "registration" | "credentials";
  meta?: Record<string, string | number | null | undefined>;
};

export type NotifyResult = {
  sms: "sent" | "skipped" | "failed";
  whatsapp: "sent" | "skipped" | "failed";
  detail?: string;
};

export function normalizePhoneE164(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  if (d.length === 13 && d.startsWith("091")) return `+91${d.slice(3)}`;
  if (raw.startsWith("+") && d.length >= 10 && d.length <= 15) return `+${d}`;
  return null;
}

async function postWebhook(
  url: string | undefined,
  body: Record<string, unknown>,
): Promise<"sent" | "skipped" | "failed"> {
  const endpoint = url?.trim();
  if (!endpoint) return "skipped";

  const secret = process.env.NOTIFY_WEBHOOK_SECRET?.trim();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
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
    template: payload.template ?? "credentials",
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

export function registrationMessage(regNo: number, password: string): string {
  return (
    `SNP Camp: Registered. Reg no #${regNo}. ` +
    `Password: ${password}. Keep this to log in. ` +
    `Show your reg no at the desk if needed.`
  );
}

export function credentialsMessage(regNo: number, password: string): string {
  return (
    `SNP Camp: Your login — Reg no #${regNo}, Password: ${password}. ` +
    `Sign in at the patient login page.`
  );
}

export function notifyConfigured(): { sms: boolean; whatsapp: boolean } {
  return {
    sms: Boolean(process.env.SMS_WEBHOOK_URL?.trim()),
    whatsapp: Boolean(process.env.WHATSAPP_WEBHOOK_URL?.trim()),
  };
}
