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
  queue_status?: "registered" | "seen";
};

export type DeskRegisterSubmitResult = RegistrationSubmitResult;

export type { RetryDelays };

export type DeskSubmitPhase =
  | "idle"
  | "saving"
  | "failed-retryable"
  | "registered-print-ready";

export function patientPrintPath(patientId: string): string {
  return `/print/${patientId}?auto=1`;
}

export type DeskPrintTarget = {
  acquired: boolean;
    navigate(path: string): boolean;
  abandon(): void;
};

export type OpenWindowFn = (
  url?: string | URL,
  target?: string,
  features?: string,
) => { closed: boolean; opener: unknown; location: { href: string }; close: () => void } | null;

export function acquireDeskPrintTarget(
  openWindow: OpenWindowFn,
): DeskPrintTarget {
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
  } catch {}

  let abandoned = false;
  return {
    acquired: true,
    navigate(path: string) {
      if (abandoned) return false;
      try {
        if (handle.closed) return false;
        handle.location.href = path;
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
      } catch {}
    },
  };
}

export function isRetryableRegistrationError(
  result: DeskRegisterSubmitResult,
): boolean {
  if (!result.error) return false;
  if (result.aadhaarDuplicateRegNo != null) return false;
  if (result.likelyDuplicateRegNo != null) return false;
  return result.retryable === true;
}

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
  print: "navigated" | "recovery" | "skipped";
};

export type DeskRegisterFailure = {
  ok: false;
  error: string;
  aadhaarDuplicateRegNo?: number | null;
  likelyDuplicateRegNo?: number | null;
  showTryAgain: boolean;
};

export async function runDeskRegisterAndPrint(options: {
  attempt: Pick<RegistrationAttempt, "id">;
  staffFields: StaffRegistrationFields;
  rpc: DeskRegisterRpc;
  printTarget: DeskPrintTarget | null;
  resetForm: () => void;
  rotateAttempt: () => void;
  sleep?: (ms: number) => Promise<void>;
  onSuccess?: (info: {
    row: DeskRegisterRow;
    print: "navigated" | "recovery" | "skipped";
  }) => void;
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

  // Register-only (#107): no print target — skip the window entirely.
  let print: "navigated" | "recovery" | "skipped";
  if (!options.printTarget) {
    print = "skipped";
  } else {
    const navigated = options.printTarget.navigate(patientPrintPath(row.id));
    print = navigated ? "navigated" : "recovery";
    if (!navigated) {
      options.printTarget.abandon();
    }
  }

  options.onSuccess?.({ row, print });

  if (options.afterRegister) {
    try {
      void Promise.resolve(options.afterRegister(row)).catch(() => {});
    } catch {}
  }

  options.rotateAttempt();
  options.resetForm();

  return {
    ok: true,
    row,
    print,
  };
}
