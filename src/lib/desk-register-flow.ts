import type { RegistrationAttempt } from "@/lib/registration-request";
import { submitRegistrationOutbound } from "@/lib/registration-request";
import type { StaffRegistrationFields } from "@/lib/registration-request";

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
};

/** Transient network/service failures are retried; Aadhaar conflicts are not. */
export function isRetryableRegistrationError(
  result: DeskRegisterSubmitResult,
): boolean {
  if (!result.error) return false;
  if (result.aadhaarDuplicateRegNo != null) return false;
  return true;
}

export type RetryDelays = {
  /** Attempts after the first call. Default two → three tries total. */
  extraAttempts?: number;
  /** Delay before each retry (ms). Length should match extraAttempts. */
  delaysMs?: number[];
};

/**
 * Call `attempt` up to 1 + extraAttempts times, reusing the same work unit.
 * Does not rotate the registration attempt id.
 */
export async function withRegistrationRetries(
  attempt: () => Promise<DeskRegisterSubmitResult>,
  options: RetryDelays & {
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<DeskRegisterSubmitResult> {
  const extra = options.extraAttempts ?? 2;
  const delays = options.delaysMs ?? [250, 750];
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let last: DeskRegisterSubmitResult = {
    data: null,
    error: "Could not save. Check the internet and press Try Again.",
  };

  for (let i = 0; i <= extra; i += 1) {
    if (i > 0) {
      const delay = delays[i - 1] ?? delays[delays.length - 1] ?? 500;
      await sleep(delay);
    }
    last = await attempt();
    if (!last.error) return last;
    if (!isRetryableRegistrationError(last)) return last;
  }

  return {
    ...last,
    // Volunteer-facing copy after exhausted retries (#47).
    error: "Could not save. Check the internet and press Try Again.",
  };
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
}): Promise<
  | { ok: true; row: DeskRegisterRow }
  | {
      ok: false;
      error: string;
      aadhaarDuplicateRegNo?: number | null;
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
    };
  }

  const row = (Array.isArray(result.data)
    ? result.data[0]
    : result.data) as DeskRegisterRow | null | undefined;

  if (!row?.id) {
    return { ok: false, error: "Could not save. Check the internet and press Try Again." };
  }

  // Order is deliberate: patient is already registered/queued, then print opens.
  // A cancelled print leaves them registered/queued — correct for the desk.
  options.openPrint(row.id);
  options.rotateAttempt();
  options.resetForm();

  return { ok: true, row };
}
