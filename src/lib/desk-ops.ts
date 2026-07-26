/**
 * Desk ops with shared quiet retry (#32).
 *
 * Idempotency guarantees (safe to auto-retry):
 * - lookup_patient_scan — read-only; COMMENT ON FUNCTION: "No side effects."
 * - assign_patient_doctor — SELECT … FOR UPDATE; if queue_status is already
 *   `seen`, returns original doctor with already_seen / error_code (does not
 *   re-assign or change seen_by). Success-after-timeout surfaces as already_seen.
 * - change_camp_day — patient + target day FOR UPDATE; same-day early return;
 *   seat count checked under the day lock before UPDATE.
 */

import { isSuccessfulAssignment } from "@/lib/queue-assignment";
import { RETRY_EXHAUSTED_COPY, withRetries } from "@/lib/with-retries";

export type DeskRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

export type LookupRow = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  phone: string | null;
  doctor_id: string | null;
  doctor_name: string | null;
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

type Step<T> =
  | { done: false }
  | { done: true; value: T };

function firstRow<T>(data: unknown): T | null {
  if (data == null) return null;
  return (Array.isArray(data) ? data[0] : data) as T;
}

/** Business outcomes that must not burn auto-retries. */
function isNonTransientRpcMessage(message: string): boolean {
  return /full|Cannot change|no longer active|Not allowed|does not belong|Day not found|Patient not found|Invalid or disabled|inactive camp|Unsupported|active staff|Provide patient/i.test(
    message,
  );
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

/** QR / reg scan lookup — read-only RPC. */
export async function lookupPatientScanWithRetries(options: {
  patientId?: string | null;
  regNo?: number | null;
  rpc: DeskRpc;
  mapRpcError: (message: string) => string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  | { ok: true; row: LookupRow }
  | { ok: false; error: string; notFound?: boolean }
> {
  type Out =
    | { ok: true; row: LookupRow }
    | { ok: false; error: string; notFound?: boolean };

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc("lookup_patient_scan", {
          p_patient_id: options.patientId ?? null,
          p_reg_no: options.regNo ?? null,
        });
        if (error) {
          if (isNonTransientRpcMessage(error.message)) {
            return {
              done: true,
              value: { ok: false, error: options.mapRpcError(error.message) },
            };
          }
          return { done: false };
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
      } catch {
        return { done: false };
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
  mapRpcError: (message: string) => string;
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

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc("assign_patient_doctor", {
          p_patient_id: options.patientId ?? null,
          p_reg_no: options.regNo ?? null,
          p_doctor_id: doctorId,
        });
        if (error) {
          if (isNonTransientRpcMessage(error.message)) {
            return {
              done: true,
              value: { ok: false, error: options.mapRpcError(error.message) },
            };
          }
          return { done: false };
        }
        const row = firstRow<AssignRow>(data);
        if (!row) {
          return { done: false };
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
      } catch {
        return { done: false };
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
  mapRpcError: (message: string) => string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  { ok: true; row: ChangeDayRow } | { ok: false; error: string }
> {
  type Out = { ok: true; row: ChangeDayRow } | { ok: false; error: string };

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc("change_camp_day", {
          p_patient_id: options.patientId,
          p_new_day_id: options.newDayId,
        });
        if (error) {
          if (isNonTransientRpcMessage(error.message)) {
            return {
              done: true,
              value: { ok: false, error: options.mapRpcError(error.message) },
            };
          }
          return { done: false };
        }
        const row = firstRow<ChangeDayRow>(data);
        if (!row?.camp_day_id) {
          return { done: false };
        }
        return { done: true, value: { ok: true, row } };
      } catch {
        return { done: false };
      }
    },
    { ok: false, error: RETRY_EXHAUSTED_COPY.changeDay },
    options.sleep,
  );
}
