
import {
  classifyOperationError,
  type DbErrorLike,
} from "@/lib/public-error";
import { RETRY_EXHAUSTED_COPY, withRetries } from "@/lib/with-retries";

export type DeskRpcError = NonNullable<DbErrorLike> & {
  message: string;
};

export type DeskRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: DeskRpcError | null }>;

export type LookupRow = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  phone: string | null;
  seen_at: string | null;
  seen_by_name: string | null;
  printed_at: string | null;
};

export type MarkSeenRow = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  seen_at: string | null;
  seen_by_name: string | null;
  already_seen: boolean;
  error_code: string | null;
};

export type UndoSeenRow = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  error_code: string | null;
};

export type ChangeDayRow = {
  id: string;
  reg_no: number;
  full_name: string;
  camp_day_id: string;
  day_date: string;
};

export type PrintPrescriptionRow = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  already_printed: boolean;
};

export type RegisteredSearchRow = {
  id: string;
  reg_no: number;
  full_name: string;
  age: number | null;
  address: string | null;
};

export type DeskPatientSearchRow = RegisteredSearchRow & {
  queue_status: "registered" | "seen";
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

export async function lookupPatientScanWithRetries(options: {
  patientId?: string | null;
  regNo?: number | null;
  rpc: DeskRpc;
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

export const NEVER_PRINTED_COPY =
  "Pehle inki parchi print karein — tabhi dekha hua kar sakte hain.";

export async function markSeenWithRetries(options: {
  patientId?: string | null;
  regNo?: number | null;
  rpc: DeskRpc;
  errorContext?: string;
  errorFallback?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  | { ok: true; row: MarkSeenRow }
  | { ok: false; error: string; neverPrinted?: boolean }
> {
  type Out =
    | { ok: true; row: MarkSeenRow }
    | { ok: false; error: string; neverPrinted?: boolean };

  const context = options.errorContext ?? "desk-ops.mark-seen";
  const fallback =
    options.errorFallback ?? "Could not mark this patient seen. Try again.";

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc("mark_seen", {
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
        const row = firstRow<MarkSeenRow>(data);
        if (!row) {
          return {
            done: true,
            value: {
              ok: false,
              error: "Could not mark this patient seen. Refresh and try again.",
            },
          };
        }
        if (row.error_code === "never_printed") {
          return {
            done: true,
            value: { ok: false, error: NEVER_PRINTED_COPY, neverPrinted: true },
          };
        }
        if (row.already_seen || row.queue_status === "seen") {
          return { done: true, value: { ok: true, row } };
        }
        return {
          done: true,
          value: {
            ok: false,
            error: "Mark seen did not complete. No success was recorded.",
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
    { ok: false, error: RETRY_EXHAUSTED_COPY.markSeen },
    options.sleep,
  );
}

export async function undoMarkSeenWithRetries(options: {
  patientId: string;
  rpc: DeskRpc;
  errorContext?: string;
  errorFallback?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: true; row: UndoSeenRow } | { ok: false; error: string }> {
  type Out = { ok: true; row: UndoSeenRow } | { ok: false; error: string };

  const context = options.errorContext ?? "desk-ops.undo-mark-seen";
  const fallback = options.errorFallback ?? "Could not undo. Try again.";

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc("undo_mark_seen", {
          p_patient_id: options.patientId,
        });
        if (error) {
          const classified = classifyRpcFailure(error, context, fallback);
          if (classified.retryable) return { done: false };
          return {
            done: true,
            value: { ok: false, error: classified.publicMessage },
          };
        }
        const row = firstRow<UndoSeenRow>(data);
        if (!row) {
          return {
            done: true,
            value: { ok: false, error: "Could not undo. Refresh and try again." },
          };
        }
        if (row.error_code === "undo_window_expired") {
          return {
            done: true,
            value: {
              ok: false,
              error: "Too late to undo — ask an admin to correct this.",
            },
          };
        }
        if (row.error_code === "clinical_started") {
          return {
            done: true,
            value: {
              ok: false,
              error:
                "Clinical transcription has started. Ask an admin for a reasoned correction.",
            },
          };
        }
        if (row.error_code === "not_seen") {
          return {
            done: true,
            value: { ok: false, error: "This patient is not marked seen." },
          };
        }
        if (row.error_code === "inactive_camp") {
          return {
            done: true,
            value: {
              ok: false,
              error: "This camp is no longer active, so the result cannot be reopened.",
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
    { ok: false, error: RETRY_EXHAUSTED_COPY.undo },
    options.sleep,
  );
}

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

export async function printPrescriptionWithRetries(options: {
  patientId?: string | null;
  regNo?: number | null;
  rpc: DeskRpc;
  errorContext?: string;
  errorFallback?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  { ok: true; row: PrintPrescriptionRow } | { ok: false; error: string }
> {
  type Out =
    | { ok: true; row: PrintPrescriptionRow }
    | { ok: false; error: string };

  const context = options.errorContext ?? "desk-ops.print-prescription";
  const fallback =
    options.errorFallback ??
    "Parchi print nahi ho payi. Dobara try karein.";

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc("mark_patient_printed", {
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
        const row = firstRow<PrintPrescriptionRow>(data);
        if (!row) {
          return {
            done: true,
            value: {
              ok: false,
              error: "Parchi print nahi ho payi. Refresh karke try karein.",
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
    { ok: false, error: RETRY_EXHAUSTED_COPY.printPrescription },
    options.sleep,
  );
}

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

export async function searchDeskPatientsWithRetries(options: {
  campId: string;
  query: string;
  limit?: number;
  rpc: DeskRpc;
  errorContext?: string;
  errorFallback?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  { ok: true; rows: DeskPatientSearchRow[] } | { ok: false; error: string }
> {
  type Out =
    | { ok: true; rows: DeskPatientSearchRow[] }
    | { ok: false; error: string };
  const context = options.errorContext ?? "desk-ops.desk-search";
  const fallback =
    options.errorFallback ?? "Could not search patients. Try again.";

  return withTransientSteps<Out>(
    async () => {
      try {
        const { data, error } = await options.rpc("search_desk_patients", {
          p_camp_id: options.campId,
          p_query: options.query,
          p_limit: options.limit ?? 10,
        });
        if (error) {
          const classified = classifyRpcFailure(error, context, fallback);
          if (classified.retryable) return { done: false };
          return {
            done: true,
            value: { ok: false, error: classified.publicMessage },
          };
        }
        const rows = (
          Array.isArray(data) ? data : data ? [data] : []
        ) as DeskPatientSearchRow[];
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
