/**
 * Durable SMS delivery ledger helpers (#65).
 * Server-only semantics via Supabase RPC; never stores full phone or message body.
 */

export type SmsDeliveryKind = "registration" | "reminder";
export type SmsDeliveryOutcome = "sent" | "failed" | "ambiguous" | "release";

export type SmsClaim = {
  deliveryId: string;
  claimToken: string;
};

/** Minimal PostgREST-shaped client (session or service role). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SmsDeliveryClient = { rpc: (fn: string, args?: Record<string, unknown>) => any };

export function phoneLast4FromRaw(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

/**
 * Atomically claim a logical delivery for dispatch.
 * Returns null when already sent/ambiguous or another runner holds a live lease.
 */
export async function claimSmsDelivery(
  client: SmsDeliveryClient,
  input: {
    patientId: string;
    kind: SmsDeliveryKind;
    phoneLast4?: string | null;
    leaseSeconds?: number;
  },
): Promise<SmsClaim | null> {
  const { data, error } = await client.rpc("claim_sms_delivery", {
    p_patient_id: input.patientId,
    p_kind: input.kind,
    p_phone_last4: input.phoneLast4 ?? null,
    p_lease_seconds: input.leaseSeconds ?? 120,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.delivery_id || !row?.claim_token) return null;
  return {
    deliveryId: String(row.delivery_id),
    claimToken: String(row.claim_token),
  };
}

export async function completeSmsDelivery(
  client: SmsDeliveryClient,
  input: {
    deliveryId: string;
    claimToken: string;
    outcome: SmsDeliveryOutcome;
    providerRequestId?: string | null;
    lastError?: string | null;
  },
): Promise<boolean> {
  const { data, error } = await client.rpc("complete_sms_delivery", {
    p_delivery_id: input.deliveryId,
    p_claim_token: input.claimToken,
    p_outcome: input.outcome,
    p_provider_request_id: input.providerRequestId ?? null,
    p_last_error: input.lastError ?? null,
  });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

/**
 * Persist the point immediately before the provider call. If the worker dies
 * after this succeeds, an expired lease is ambiguous and is never auto-retried.
 */
export async function markSmsDispatchStarted(
  client: SmsDeliveryClient,
  claim: SmsClaim,
): Promise<boolean> {
  const { data, error } = await client.rpc("mark_sms_dispatch_started", {
    p_delivery_id: claim.deliveryId,
    p_claim_token: claim.claimToken,
  });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

export type SmsDeliveryIssue = {
  at: string;
  template: "registration" | "reminder" | "test";
  detail: string;
  phoneLast4?: string;
  state?: string;
};

/** Admin-only redacted failed/ambiguous rows (durable across instances). */
export async function listRecentSmsDeliveryIssues(
  client: SmsDeliveryClient,
  limit = 50,
): Promise<SmsDeliveryIssue[]> {
  const { data, error } = await client.rpc("list_recent_sms_delivery_issues", {
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    at: string;
    template: string;
    detail: string;
    phone_last4: string | null;
    state: string;
  }>;
  return rows.map((r) => ({
    at: r.at,
    template: (r.template === "reminder" ? "reminder" : "registration") as
      | "registration"
      | "reminder",
    detail: String(r.detail || "").slice(0, 300),
    phoneLast4: r.phone_last4 ?? undefined,
    state: r.state,
  }));
}

export async function pruneSmsDeliveries(
  client: SmsDeliveryClient,
): Promise<number> {
  const { data, error } = await client.rpc("prune_sms_deliveries");
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

/**
 * Classify MSG91 adapter failure for ledger outcome.
 * Provider HTTP rejection → failed (safe to retry).
 * Timeout / connection loss → ambiguous (do not auto-retry).
 */
export function smsOutcomeFromProviderFailure(detail: string): {
  outcome: "failed" | "ambiguous";
  detail: string;
} {
  const d = String(detail || "").slice(0, 300);
  const lower = d.toLowerCase();
  if (
    lower.includes("timeout") ||
    lower.includes("aborted") ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("socket")
  ) {
    return { outcome: "ambiguous", detail: d };
  }
  return { outcome: "failed", detail: d };
}
