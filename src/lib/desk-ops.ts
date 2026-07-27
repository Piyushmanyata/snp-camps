/**
 * Desk ops with shared quiet retry (#32, #60, #61).
 *
 * Idempotency guarantees (safe to auto-retry):
 * - lookup_patient_scan — read-only; COMMENT ON FUNCTION: "No side effects."
 * - assign_patient_doctor — SELECT … FOR UPDATE; if queue_status is already
 *   `seen`, returns original doctor with already_seen / error_code (does not
 *   re-assign or change seen_by). Success-after-timeout surfaces as already_seen.
 * - change_camp_day — patient + target day FOR UPDATE; same-day early return;
 *   seat count checked under the day lock before UPDATE.
 * - check_in_patient — registered → waiting; waiting is idempotent (same queued_at);
 *   seen is a terminal business result (error_code already_seen).
 * - search_registered_patients — read-only; empty rows ≠ error.
 *
 * Retry uses classifyOperationError allow-list only (transient transport / DB).
 * Terminal business, permission, validation, and capacity results are not retried.
 */

import {
  classifyOperationError,
  type DbErrorLike,
} from "@/lib/public-error";
import { isSuccessfulAssignment } from "@/lib/queue-assignment";
import { RETRY_EXHAUSTED_COPY, withRetries } from "@/lib/with-retries";

export type DeskRpcError = NonNullable<DbErrorLike> & {
  message: string;
};

export type DeskRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: DeskRpcError | null }>;

export type PrescriptionAmendmentItem = {
  id: string;
  author_id: string;
  author_name: string;
  content: string;
  created_at: string;
};

export type LookupRow = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  phone: string | null;
  doctor_id: string | null;
  doctor_name: string | null;
  prescription_id?: string | null;
  diagnosis?: string | null;
  examination?: string | null;
  medicines?: string | null;
  advice?: string | null;
  spectacles_type?: string | null;
  destinations?: string[] | null;
  is_locked?: boolean | null;
  amendments?: PrescriptionAmendmentItem[] | null;
  theatre_capacity?: number | null;
  theatre_reserved?: number | null;
  theatre_remaining?: number | null;
  ot_scheduled_day_id?: string | null;
  ot_scheduled_day_date?: string | null;
  next_available_ot_day_date?: string | null;
};

export type AssignRow = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  doctor_id: string | null;
  doctor_name: string | null;
  already_seen: boolean;
  error_code: string | null;
};

export type ChangeDayRow = {
  id: string;
  reg_no: number;
  full_name: string;
  camp_day_id: string;
  day_date: string;
};

export type CheckInRow = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  already_waiting: boolean;
  doctor_name: string | null;
  error_code: string | null;
};

/** Lost-slip search row — name/age/locality only (no phone/token/status). */
export type RegisteredSearchRow = {
  id: string;
  reg_no: number;
  full_name: string;
  age: number | null;
  address: string | null;
};

type Step<T> =
  | { done: false }
  | { done: true; value: T };

function firstRow<T>(data: unknown): T | null {
  if (data == null) return null;
  return (Array.isArray(data) ? data[0] : data) as T;
}

async function withTransientSteps<T>(
  step: () => Promise<Step<T>>,
  exhausted: T,
  sleep?: (ms: number) => Promise<void>,
): Promise<T> {
  const last = await withRetries(step, {
    sleep,
    shouldRetry: (s) => !s.done,
    mapExhausted: () => ({ done: true as const, value: exhausted }),
  });
  return last.done ? last.value : exhausted;
}

/** Map a structured RPC error; terminal vs retry decided by classifier (#60). */
function classifyRpcFailure(
  error: DeskRpcError,
  context: string,
  fallback: string,
): { retryable: boolean; publicMessage: string } {
  const classified = classifyOperationError(error, {
    context,
    fallback,
  });
  return {
    retryable: classified.retryable,
    publicMessage: classified.publicMessage,
  };
}

/** QR / reg scan lookup — read-only RPC. */
export async function lookupPatientScanWithRetries(options: {
  patientId?: string | null;
  regNo?: number | null;
  rpc: DeskRpc;
  /** @deprecated Prefer errorContext/errorFallback. */
  mapRpcError?: (message: string) => string;
  errorContext?: string;
  errorFallback?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  | { ok: true; row: LookupRow }
  | { ok: false; error: string; notFound?: boolean }
> {
  type Out =
    | { ok: true; row: LookupRow }
    | { ok: false; error: string; notFound?: boolean };

  const context = options.errorContext ?? "desk-ops.lookup";
  const fallback =
    options.errorFallback ?? "Could not look up this patient. Try again.";

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc("lookup_patient_scan", {
          p_patient_id: options.patientId ?? null,
          p_reg_no: options.regNo ?? null,
        });
        if (error) {
          const classified = classifyRpcFailure(error, context, fallback);
          if (classified.retryable) return { done: false };
          return {
            done: true,
            value: { ok: false, error: classified.publicMessage },
          };
        }
        const row = firstRow<LookupRow>(data);
        if (!row) {
          return {
            done: true,
            value: {
              ok: false,
              error: "Patient not found.",
              notFound: true,
            },
          };
        }
        return { done: true, value: { ok: true, row } };
      } catch (thrown) {
        const classified = classifyOperationError(thrown, {
          context,
          transportFailure: true,
          log: true,
          fallback,
        });
        if (classified.retryable) return { done: false };
        return {
          done: true,
          value: { ok: false, error: classified.publicMessage },
        };
      }
    },
    { ok: false, error: RETRY_EXHAUSTED_COPY.lookup },
    options.sleep,
  );
}

/** Worker-facing copy for #57 registered → seen rejection. */
export const CHECK_IN_REQUIRED_COPY =
  "Check the patient in first, then mark them seen.";

/**
 * Assign doctor / mark seen.
 * already_seen is a successful terminal outcome (idempotent re-call).
 * check_in_required is a terminal business rejection (no auto-retry).
 */
export async function assignPatientDoctorWithRetries(options: {
  patientId?: string | null;
  regNo?: number | null;
  /** Fixed for all retries — never rotate doctor mid-retry. */
  doctorId: string | null;
  rpc: DeskRpc;
  mapRpcError?: (message: string) => string;
  errorContext?: string;
  errorFallback?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  | { ok: true; row: AssignRow }
  | {
      ok: false;
      error: string;
      doctorRequired?: boolean;
      checkInRequired?: boolean;
    }
> {
  type Out =
    | { ok: true; row: AssignRow }
    | {
        ok: false;
        error: string;
        doctorRequired?: boolean;
        checkInRequired?: boolean;
      };

  const doctorId = options.doctorId;
  const context = options.errorContext ?? "desk-ops.assign";
  const fallback =
    options.errorFallback ?? "Could not assign this patient. Try again.";

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc("assign_patient_doctor", {
          p_patient_id: options.patientId ?? null,
          p_reg_no: options.regNo ?? null,
          p_doctor_id: doctorId,
        });
        if (error) {
          const classified = classifyRpcFailure(error, context, fallback);
          if (classified.retryable) {
            return { done: false };
          }
          return {
            done: true,
            value: { ok: false, error: classified.publicMessage },
          };
        }
        const row = firstRow<AssignRow>(data);
        if (!row) {
          // Empty success body is ambiguous — treat as transient only if no row
          // at all after a completed RPC is rare; do not burn retries on null
          // business outcomes. Prefer terminal safe copy.
          return {
            done: true,
            value: {
              ok: false,
              error: "Could not assign this patient. Refresh and try again.",
            },
          };
        }
        if (row.error_code === "doctor_required") {
          return {
            done: true,
            value: {
              ok: false,
              error: "Select a doctor.",
              doctorRequired: true,
            },
          };
        }
        if (row.error_code === "check_in_required") {
          return {
            done: true,
            value: {
              ok: false,
              error: CHECK_IN_REQUIRED_COPY,
              checkInRequired: true,
            },
          };
        }
        if (
          row.error_code === "already_seen" ||
          row.already_seen ||
          isSuccessfulAssignment(row)
        ) {
          return { done: true, value: { ok: true, row } };
        }
        return {
          done: true,
          value: {
            ok: false,
            error: row.error_code
              ? "Could not assign this patient. Refresh and try again."
              : "Doctor assignment did not complete. No success was recorded.",
          },
        };
      } catch (thrown) {
        const classified = classifyOperationError(thrown, {
          context,
          transportFailure: true,
          log: true,
          fallback,
        });
        if (classified.retryable) return { done: false };
        return {
          done: true,
          value: { ok: false, error: classified.publicMessage },
        };
      }
    },
    { ok: false, error: RETRY_EXHAUSTED_COPY.assign },
    options.sleep,
  );
}

/** Move a registered patient to another camp day (seat lock in RPC). */
export async function changeCampDayWithRetries(options: {
  patientId: string;
  newDayId: string;
  rpc: DeskRpc;
  mapRpcError?: (message: string) => string;
  errorContext?: string;
  errorFallback?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  { ok: true; row: ChangeDayRow } | { ok: false; error: string }
> {
  type Out = { ok: true; row: ChangeDayRow } | { ok: false; error: string };

  const context = options.errorContext ?? "desk-ops.change-day";
  const fallback =
    options.errorFallback ?? "Could not change the day. Try again.";

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc("change_camp_day", {
          p_patient_id: options.patientId,
          p_new_day_id: options.newDayId,
        });
        if (error) {
          const classified = classifyRpcFailure(error, context, fallback);
          if (classified.retryable) {
            return { done: false };
          }
          return {
            done: true,
            value: { ok: false, error: classified.publicMessage },
          };
        }
        const row = firstRow<ChangeDayRow>(data);
        if (!row?.camp_day_id) {
          // Missing row after successful RPC is not a transport failure.
          return {
            done: true,
            value: {
              ok: false,
              error: "Could not change the day. Refresh and try again.",
            },
          };
        }
        return { done: true, value: { ok: true, row } };
      } catch (thrown) {
        const classified = classifyOperationError(thrown, {
          context,
          transportFailure: true,
          log: true,
          fallback,
        });
        if (classified.retryable) return { done: false };
        return {
          done: true,
          value: { ok: false, error: classified.publicMessage },
        };
      }
    },
    { ok: false, error: RETRY_EXHAUSTED_COPY.changeDay },
    options.sleep,
  );
}

/**
 * Check-in (registered → waiting). Shared by reg number, QR paste, name row,
 * scanner auto-check-in, and likely-duplicate "check in instead" (#61).
 * Transient failures retry; already_seen / permission / unknown are terminal.
 */
export async function checkInPatientWithRetries(options: {
  patientId?: string | null;
  regNo?: number | null;
  rpc: DeskRpc;
  errorContext?: string;
  errorFallback?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  | { ok: true; row: CheckInRow }
  | {
      ok: false;
      error: string;
      alreadySeen?: boolean;
      doctorName?: string | null;
    }
> {
  type Out =
    | { ok: true; row: CheckInRow }
    | {
        ok: false;
        error: string;
        alreadySeen?: boolean;
        doctorName?: string | null;
      };

  const context = options.errorContext ?? "desk-ops.check-in";
  const fallback =
    options.errorFallback ?? "Could not check in this patient. Try again.";

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc("check_in_patient", {
          p_patient_id: options.patientId ?? null,
          p_reg_no: options.regNo ?? null,
        });
        if (error) {
          const classified = classifyRpcFailure(error, context, fallback);
          if (classified.retryable) return { done: false };
          return {
            done: true,
            value: { ok: false, error: classified.publicMessage },
          };
        }
        const row = firstRow<CheckInRow>(data);
        if (!row) {
          return {
            done: true,
            value: {
              ok: false,
              error: "Could not check in this patient. Refresh and try again.",
            },
          };
        }
        if (row.error_code === "already_seen" || row.queue_status === "seen") {
          return {
            done: true,
            value: {
              ok: false,
              error: row.doctor_name
                ? `Already seen by ${row.doctor_name}`
                : "Already seen",
              alreadySeen: true,
              doctorName: row.doctor_name ?? null,
            },
          };
        }
        return { done: true, value: { ok: true, row } };
      } catch (thrown) {
        const classified = classifyOperationError(thrown, {
          context,
          transportFailure: true,
          log: true,
          fallback,
        });
        if (classified.retryable) return { done: false };
        return {
          done: true,
          value: { ok: false, error: classified.publicMessage },
        };
      }
    },
    { ok: false, error: RETRY_EXHAUSTED_COPY.checkIn },
    options.sleep,
  );
}

/**
 * Lost-slip name search — read-only. Failures never collapse to empty success (#61).
 * Empty rows mean no match; RPC/transport errors return { ok: false }.
 */
export async function searchRegisteredPatientsWithRetries(options: {
  campId: string;
  query: string;
  limit?: number;
  rpc: DeskRpc;
  errorContext?: string;
  errorFallback?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  { ok: true; rows: RegisteredSearchRow[] } | { ok: false; error: string }
> {
  type Out =
    | { ok: true; rows: RegisteredSearchRow[] }
    | { ok: false; error: string };

  const context = options.errorContext ?? "desk-ops.search";
  const fallback =
    options.errorFallback ?? "Could not search names. Try again.";

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc(
          "search_registered_patients",
          {
            p_camp_id: options.campId,
            p_query: options.query,
            p_limit: options.limit ?? 10,
          },
        );
        if (error) {
          const classified = classifyRpcFailure(error, context, fallback);
          if (classified.retryable) return { done: false };
          return {
            done: true,
            value: { ok: false, error: classified.publicMessage },
          };
        }
        const rows = (Array.isArray(data) ? data : data ? [data] : []) as RegisteredSearchRow[];
        return { done: true, value: { ok: true, rows } };
      } catch (thrown) {
        const classified = classifyOperationError(thrown, {
          context,
          transportFailure: true,
          log: true,
          fallback,
        });
        if (classified.retryable) return { done: false };
        return {
          done: true,
          value: { ok: false, error: classified.publicMessage },
        };
      }
    },
    { ok: false, error: RETRY_EXHAUSTED_COPY.search },
    options.sleep,
  );
}

export type SubmitPrescriptionRow = {
  prescription_id: string;
  patient_id: string;
  reg_no: number;
  queue_status: string;
  created_orders_count: number;
  scheduled_camp_day_id?: string | null;
  scheduled_day_date?: string | null;
};

export async function doctorSubmitPrescriptionWithRetries(options: {
  patientId: string;
  diagnosis?: string | null;
  examination?: string | null;
  medicines?: string | null;
  advice?: string | null;
  spectaclesType?: "fixed" | "bifocal" | null;
  destinations?: string[];
  rpc: DeskRpc;
  errorContext?: string;
  errorFallback?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  | { ok: true; row: SubmitPrescriptionRow }
  | { ok: false; error: string }
> {
  type Out =
    | { ok: true; row: SubmitPrescriptionRow }
    | { ok: false; error: string };

  const context = options.errorContext ?? "desk-ops.submit-prescription";
  const fallback =
    options.errorFallback ?? "Could not submit prescription. Try again.";

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc(
          "doctor_submit_prescription",
          {
            p_patient_id: options.patientId,
            p_diagnosis: options.diagnosis ?? null,
            p_examination: options.examination ?? null,
            p_medicines: options.medicines ?? null,
            p_advice: options.advice ?? null,
            p_spectacles_type: options.spectaclesType ?? null,
            p_destinations: options.destinations ?? [],
          },
        );
        if (error) {
          const classified = classifyRpcFailure(error, context, fallback);
          if (classified.retryable) return { done: false };
          return {
            done: true,
            value: { ok: false, error: classified.publicMessage },
          };
        }
        const row = firstRow<SubmitPrescriptionRow>(data);
        if (!row) {
          return {
            done: true,
            value: {
              ok: false,
              error: "Prescription submission did not complete. Try again.",
            },
          };
        }
        return { done: true, value: { ok: true, row } };
      } catch (thrown) {
        const classified = classifyOperationError(thrown, {
          context,
          transportFailure: true,
          log: true,
          fallback,
        });
        if (classified.retryable) return { done: false };
        return {
          done: true,
          value: { ok: false, error: classified.publicMessage },
        };
      }
    },
    { ok: false, error: RETRY_EXHAUSTED_COPY.prescription },
    options.sleep,
  );
}

export type AmendmentRow = {
  id: string;
  prescription_id: string;
  author_id: string;
  content: string;
  created_at: string;
};

export async function addPrescriptionAmendmentWithRetries(options: {
  prescriptionId: string;
  content: string;
  rpc: DeskRpc;
  errorContext?: string;
  errorFallback?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  | { ok: true; row: AmendmentRow }
  | { ok: false; error: string }
> {
  type Out =
    | { ok: true; row: AmendmentRow }
    | { ok: false; error: string };

  const context = options.errorContext ?? "desk-ops.add-amendment";
  const fallback =
    options.errorFallback ?? "Could not add amendment. Try again.";

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc(
          "add_prescription_amendment",
          {
            p_prescription_id: options.prescriptionId,
            p_content: options.content,
          },
        );
        if (error) {
          const classified = classifyRpcFailure(error, context, fallback);
          if (classified.retryable) return { done: false };
          return {
            done: true,
            value: { ok: false, error: classified.publicMessage },
          };
        }
        const row = firstRow<AmendmentRow>(data);
        if (!row) {
          return {
            done: true,
            value: {
              ok: false,
              error: "Adding amendment did not complete. Try again.",
            },
          };
        }
        return { done: true, value: { ok: true, row } };
      } catch (thrown) {
        const classified = classifyOperationError(thrown, {
          context,
          transportFailure: true,
          log: true,
          fallback,
        });
        if (classified.retryable) return { done: false };
        return {
          done: true,
          value: { ok: false, error: classified.publicMessage },
        };
      }
    },
    { ok: false, error: RETRY_EXHAUSTED_COPY.prescription },
    options.sleep,
  );
}


