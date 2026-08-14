
export type Msg91SendInput = {
  mobiles: string;
  templateId: string;
  senderId: string;
  authKey: string;
  variables: Record<string, string>;
};

export type Msg91SendResult =
  | { ok: true; requestId?: string }
  | {
      ok: false;
      detail: string;
      failureKind?: "rejected" | "uncertain";
    };

const FLOW_URL = "https://control.msg91.com/api/v5/flow/";

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
        failureKind: res.status >= 500 ? "uncertain" : "rejected",
      };
    }
    let requestId: string | undefined;
    try {
      const parsed = JSON.parse(text) as { request_id?: string; message?: string };
      if (typeof parsed.request_id === "string") requestId = parsed.request_id;
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
          failureKind: "rejected",
        };
      }
    } catch {
    }
    return { ok: true, requestId };
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "MSG91 request failed";
    return {
      ok: false,
      detail: detail.slice(0, 200),
      failureKind: "uncertain",
    };
  }
}
