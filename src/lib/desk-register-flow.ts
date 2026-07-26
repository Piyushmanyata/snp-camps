import type { RegistrationAttempt } from "@/lib/registration-request";
import { submitRegistrationOutbound } from "@/lib/registration-request";
import type { StaffRegistrationFields } from "@/lib/registration-request";
import {
  RETRY_EXHAUSTED_COPY,
  withRetries,
  type RetryDelays,
} from "@/lib/with-retries";

export type DeskRegisterRpc = NonNullable<
  Parameters<typeof submitRegistrationOutbound>[0]["rpc"]
>;

export type DeskRegisterRow = {
  id: string;
  reg_no: number;
  full_name: string;
  camp_day_id?: string;
  day_date?: string;
  queue_status?: "registered" | "waiting" | "seen";
};

export type DeskRegisterSubmitResult = {
  data: unknown;
  error: string | null;
  aadhaarDuplicateRegNo?: number | null;
  likelyDuplicateRegNo?: number | null;
};

export type { RetryDelays };

/** Transient network/service failures are retried; duplicate warnings are not. */
export function isRetryableRegistrationError(
  result: DeskRegisterSubmitResult,
): boolean {
  if (!result.error) return false;
  if (result.aadhaarDuplicateRegNo != null) return false;
  if (result.likelyDuplicateRegNo != null) return false;
  return true;
}

/**
 * Call `attempt` up to 1 + extraAttempts times, reusing the same work unit.
 * Does not rotate the registration attempt id. Uses shared withRetries (#32).
 */
export async function withRegistrationRetries(
  attempt: () => Promise<DeskRegisterSubmitResult>,
  options: RetryDelays & {
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<DeskRegisterSubmitResult> {
  return withRetries(attempt, {
    extraAttempts: options.extraAttempts,
    delaysMs: options.delaysMs,
    sleep: options.sleep,
    shouldRetry: isRetryableRegistrationError,
    mapExhausted: (last) => ({
      ...last,
      error: RETRY_EXHAUSTED_COPY.register,
    }),
  });
}

/**
 * Register (idempotent RPC) → open print → reset form.
 * Queue/check-in already happened inside the RPC when the day is today;
 * print is never required for queue correctness.
 */
export async function runDeskRegisterAndPrint(options: {
  attempt: Pick<RegistrationAttempt, "id">;
  staffFields: StaffRegistrationFields;
  rpc: DeskRegisterRpc;
  openPrint: (patientId: string) => void;
  resetForm: () => void;
  rotateAttempt: () => void;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Fire-and-forget after a successful register (e.g. registration SMS).
   * Must never block or fail the desk — errors are swallowed.
   */
  afterRegister?: (row: DeskRegisterRow) => void | Promise<void>;
}): Promise<
  | { ok: true; row: DeskRegisterRow }
  | {
      ok: false;
      error: string;
      aadhaarDuplicateRegNo?: number | null;
      likelyDuplicateRegNo?: number | null;
    }
> {
  const result = await withRegistrationRetries(
    () =>
      submitRegistrationOutbound({
        isStaff: true,
        attempt: options.attempt,
        staffFields: options.staffFields,
        rpc: options.rpc,
      }),
    { sleep: options.sleep },
  );

  if (result.error) {
    return {
      ok: false,
      error: result.error,
      aadhaarDuplicateRegNo: result.aadhaarDuplicateRegNo ?? null,
      likelyDuplicateRegNo: result.likelyDuplicateRegNo ?? null,
    };
  }

  const row = (Array.isArray(result.data)
    ? result.data[0]
    : result.data) as DeskRegisterRow | null | undefined;

  if (!row?.id) {
    return { ok: false, error: RETRY_EXHAUSTED_COPY.register };
  }

  // Order is deliberate: patient is already registered/queued, then print opens.
  // A cancelled print leaves them registered/queued — correct for the desk.
  options.openPrint(row.id);
  if (options.afterRegister) {
    try {
      void Promise.resolve(options.afterRegister(row)).catch(() => {});
    } catch {
      // SMS / hooks must never fail registration.
    }
  }
  options.rotateAttempt();
  options.resetForm();

  return { ok: true, row };
}
