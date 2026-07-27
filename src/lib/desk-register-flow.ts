import type { RegistrationAttempt } from "@/lib/registration-request";
import {
  submitRegistrationOutbound,
  type RegistrationSubmitResult,
  type StaffRegistrationFields,
} from "@/lib/registration-request";
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

export type DeskRegisterSubmitResult = RegistrationSubmitResult;

export type { RetryDelays };

/**
 * Desk submit UI phases (#62). Distinct from transient toast text so recovery
 * and Try Again remain actionable after auto-retries or popup blocking.
 */
export type DeskSubmitPhase =
  | "idle"
  | "saving"
  | "failed-retryable"
  | "registered-print-ready";

/** Same-origin print route for one patient (thermal / one-up reprint). */
export function patientPrintPath(patientId: string): string {
  return `/print/${patientId}?auto=1`;
}

/**
 * Controlled print target acquired during the submit gesture (#62).
 * Browser APIs stay outside registration RPC logic via this adapter.
 */
export type DeskPrintTarget = {
  /** True when `window.open` returned a non-null handle (not blocked). */
  acquired: boolean;
  /**
   * Navigate the retained handle to the patient slip.
   * Returns false when blocked, closed, abandoned, or navigation throws.
   */
  navigate(patientId: string): boolean;
  /**
   * Close/neutralize an empty pre-opened target (duplicate warning,
   * validation rejection, or terminal save failure). No-op if blocked.
   */
  abandon(): void;
};

/** Minimal `window.open` shape — injectable for pure unit tests. */
export type OpenWindowFn = (
  url?: string | URL,
  target?: string,
  features?: string,
) => { closed: boolean; opener: unknown; location: { href: string }; close: () => void } | null;

/**
 * Synchronously open a same-origin blank print target during a user gesture.
 *
 * Do **not** pass the `noopener` feature: browsers return `null` for a
 * `noopener` open even when a context was created, which is indistinguishable
 * from popup blocking and leaves no handle to navigate. Immediately set
 * `handle.opener = null`, retain the handle, and navigate only after success.
 */
export function acquireDeskPrintTarget(
  openWindow: OpenWindowFn,
): DeskPrintTarget {
  // No feature string — never "noopener" (see above).
  const handle = openWindow("about:blank", "_blank");
  if (!handle) {
    return {
      acquired: false,
      navigate: () => false,
      abandon: () => {},
    };
  }

  try {
    handle.opener = null;
  } catch {
    // Retain the handle even if severing opener throws.
  }

  let abandoned = false;
  return {
    acquired: true,
    navigate(patientId: string) {
      if (abandoned) return false;
      try {
        if (handle.closed) return false;
        handle.location.href = patientPrintPath(patientId);
        return true;
      } catch {
        return false;
      }
    },
    abandon() {
      if (abandoned) return;
      abandoned = true;
      try {
        if (!handle.closed) handle.close();
      } catch {
        // Ignore close failures — blank tab is best-effort.
      }
    },
  };
}

/**
 * Transient network/DB failures only (#60).
 * Duplicates and all terminal business/permission/validation errors are not retried.
 */
export function isRetryableRegistrationError(
  result: DeskRegisterSubmitResult,
): boolean {
  if (!result.error) return false;
  if (result.aadhaarDuplicateRegNo != null) return false;
  if (result.likelyDuplicateRegNo != null) return false;
  // Explicit allow-list from classifyOperationError — never infer from English copy.
  return result.retryable === true;
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
      retryable: false,
    }),
  });
}

export type DeskRegisterSuccess = {
  ok: true;
  row: DeskRegisterRow;
  /**
   * `navigated` — retained target received the print URL.
   * `recovery` — popup blocked, target closed, or navigation failed;
   *              caller must show a deterministic same-patient Print action.
   * `skipped` — register-only (#107); no print window was requested.
   */
  print: "navigated" | "recovery" | "skipped";
};

export type DeskRegisterFailure = {
  ok: false;
  error: string;
  aadhaarDuplicateRegNo?: number | null;
  likelyDuplicateRegNo?: number | null;
  /**
   * True after exhausted transient failure — preserve fields + request id and
   * show one explicit Try Again control. False for terminal business errors.
   */
  showTryAgain: boolean;
};

/**
 * Register (idempotent RPC) → navigate pre-opened print target → reset form.
 * Queue/check-in already happened inside the RPC when the day is today;
 * print is never required for queue correctness.
 *
 * Caller must acquire `printTarget` synchronously during the submit gesture
 * **before** awaiting this function. On any non-success path the target is
 * abandoned so no orphan blank tab remains.
 */
export async function runDeskRegisterAndPrint(options: {
  attempt: Pick<RegistrationAttempt, "id">;
  staffFields: StaffRegistrationFields;
  rpc: DeskRegisterRpc;
  /**
   * Pre-opened print target for register-and-print. Pass `null` for
   * register-only (#107) — patient is saved and no print window is opened.
   */
  printTarget: DeskPrintTarget | null;
  resetForm: () => void;
  rotateAttempt: () => void;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called after print navigate/recovery decision and **before** rotate/reset,
   * so the UI can retain a print-recovery reference first (#62).
   */
  onSuccess?: (info: {
    row: DeskRegisterRow;
    print: "navigated" | "recovery" | "skipped";
  }) => void;
  /**
   * Fire-and-forget after a successful register (e.g. registration SMS).
   * Must never block or fail the desk — errors are swallowed.
   */
  afterRegister?: (row: DeskRegisterRow) => void | Promise<void>;
}): Promise<DeskRegisterSuccess | DeskRegisterFailure> {
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
    options.printTarget?.abandon();
    const showTryAgain = result.error === RETRY_EXHAUSTED_COPY.register;
    return {
      ok: false,
      error: result.error,
      aadhaarDuplicateRegNo: result.aadhaarDuplicateRegNo ?? null,
      likelyDuplicateRegNo: result.likelyDuplicateRegNo ?? null,
      showTryAgain,
    };
  }

  const row = (Array.isArray(result.data)
    ? result.data[0]
    : result.data) as DeskRegisterRow | null | undefined;

  if (!row?.id) {
    options.printTarget?.abandon();
    return {
      ok: false,
      error: RETRY_EXHAUSTED_COPY.register,
      showTryAgain: true,
    };
  }

  // Order is deliberate: patient is already registered/queued, then print opens.
  // A cancelled/blocked print leaves them registered/queued — correct for the desk.
  // Register-only (#107): no print target — skip the window entirely.
  let print: "navigated" | "recovery" | "skipped";
  if (!options.printTarget) {
    print = "skipped";
  } else {
    const navigated = options.printTarget.navigate(row.id);
    print = navigated ? "navigated" : "recovery";
    if (!navigated) {
      // Neutralize any leftover blank tab when navigation could not complete.
      options.printTarget.abandon();
    }
  }

  // Retain recovery reference before form reset clears the only route to the slip.
  options.onSuccess?.({ row, print });

  if (options.afterRegister) {
    try {
      void Promise.resolve(options.afterRegister(row)).catch(() => {});
    } catch {
      // SMS / hooks must never fail registration.
    }
  }

  // Rotate + reset only after success retained a usable patient id for recovery.
  options.rotateAttempt();
  options.resetForm();

  return {
    ok: true,
    row,
    print,
  };
}
