
import type { SectionKey } from "@/lib/section-reads";

export type SectionClientResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const GENERIC =
  "Something went wrong. Try again or ask the desk.";

export async function fetchDeskSection<T = unknown>(
  section: SectionKey,
  options: {
    campId?: string | null;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<SectionClientResult<T>> {
  const params = new URLSearchParams({ section });
  if (options.campId) params.set("campId", options.campId);

  const fetchFn = options.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`/api/desk/section?${params.toString()}`, {
      cache: "no-store",
      signal: options.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      data?: T;
      error?: string;
    };
    if (!res.ok || !body.ok) {
      return {
        ok: false,
        error:
          typeof body.error === "string" && body.error
            ? body.error
            : GENERIC,
      };
    }
    return { ok: true, data: body.data as T };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: GENERIC };
    }
    return {
      ok: false,
      error: "Could not load this section. Check your connection and try again.",
    };
  }
}
