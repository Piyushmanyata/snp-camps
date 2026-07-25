/** Result shapes from public.link_patient_phone (jsonb, #18). */

export type PhoneLinkCandidate = {
  id: string;
  reg_no: number;
  full_name: string;
  /** ISO date (YYYY-MM-DD) or null when no camp day assigned. */
  camp_day: string | null;
};

export type PhoneLinkResult =
  | { status: "linked"; patient_id: string }
  | { status: "no_match" }
  | {
      status: "choose";
      candidates: PhoneLinkCandidate[];
      ask_desk: boolean;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCandidate(raw: unknown): PhoneLinkCandidate | null {
  if (!isRecord(raw)) return null;
  const id = raw.id;
  const regNo = raw.reg_no;
  const fullName = raw.full_name;
  if (typeof id !== "string" || !id) return null;
  if (typeof regNo !== "number" || !Number.isFinite(regNo)) return null;
  if (typeof fullName !== "string") return null;
  const campDay = raw.camp_day;
  if (campDay !== null && campDay !== undefined && typeof campDay !== "string") {
    return null;
  }
  return {
    id,
    reg_no: regNo,
    full_name: fullName,
    camp_day: typeof campDay === "string" ? campDay : null,
  };
}

/** Normalize RPC jsonb (or legacy uuid) into a typed result. */
export function parsePhoneLinkResult(data: unknown): PhoneLinkResult | null {
  if (data == null) {
    return { status: "no_match" };
  }
  // Legacy uuid return (pre-#18) — treat as linked.
  if (typeof data === "string" && data.length > 0) {
    return { status: "linked", patient_id: data };
  }
  if (!isRecord(data)) return null;

  const status = data.status;
  if (status === "no_match") {
    return { status: "no_match" };
  }
  if (status === "linked") {
    const patientId = data.patient_id;
    if (typeof patientId !== "string" || !patientId) return null;
    return { status: "linked", patient_id: patientId };
  }
  if (status === "choose") {
    const list = Array.isArray(data.candidates) ? data.candidates : [];
    const candidates: PhoneLinkCandidate[] = [];
    for (const item of list) {
      const c = parseCandidate(item);
      if (c) candidates.push(c);
    }
    return {
      status: "choose",
      candidates,
      ask_desk: Boolean(data.ask_desk),
    };
  }
  return null;
}
