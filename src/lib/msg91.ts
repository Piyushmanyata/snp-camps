/**
 * MSG91 Flow/template SMS — one module, one send function (#51).
 * Swapping providers later means editing this file only.
 */

export type Msg91SendInput = {
  /** Digits with country code, no + (e.g. 919876543210). */
  mobiles: string;
  templateId: string;
  senderId: string;
  authKey: string;
  /** Named variables matching the MSG91 flow (reg, date, venue, link). */
  variables: Record<string, string>;
};

export type Msg91SendResult =
  | { ok: true; requestId?: string }
  | { ok: false; detail: string };

const FLOW_URL = "https://control.msg91.com/api/v5/flow/";

/**
 * Send one transactional template SMS via MSG91 Flow API.
 * Callers must treat failures as non-fatal for desk work.
 */
export async function sendMsg91TemplateSms(
  input: Msg91SendInput,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Msg91SendResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const authKey = input.authKey?.trim();
  const templateId = input.templateId?.trim();
  const senderId = input.senderId?.trim();
  const mobiles = input.mobiles?.replace(/\D/g, "");

  if (!authKey || !templateId || !senderId || !mobiles) {
    return { ok: false, detail: "MSG91 config or mobile missing" };
  }

  const body = {
    template_id: templateId,
    short_url: "0",
    realTimeResponse: "1",
    recipients: [
      {
        mobiles,
        ...input.variables,
      },
    ],
    sender: senderId,
  };

  try {
    const res = await fetchImpl(FLOW_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        authkey: authKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return {
        ok: false,
        detail: `MSG91 HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    let requestId: string | undefined;
    try {
      const parsed = JSON.parse(text) as { request_id?: string; message?: string };
      if (typeof parsed.request_id === "string") requestId = parsed.request_id;
      // MSG91 sometimes returns 200 with type/error in body.
      if (
        parsed &&
        typeof parsed === "object" &&
        "type" in parsed &&
        (parsed as { type?: string }).type === "error"
      ) {
        return {
          ok: false,
          detail: String(
            (parsed as { message?: string }).message || "MSG91 type=error",
          ).slice(0, 200),
        };
      }
    } catch {
      // non-JSON success body is fine
    }
    return { ok: true, requestId };
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "MSG91 request failed";
    return { ok: false, detail: detail.slice(0, 200) };
  }
}
