/**
 * Map database / PostgREST errors to camp-worker copy, and classify
 * whether a failure is safe to auto-retry (#31, #60).
 *
 * Retry policy is an allow-list of transient transport/DB classes only.
 * Unknown and business rejections are terminal (explicit user retry).
 * Technical details stay log-only — never returned to the UI.
 */

export type DbErrorLike = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
  /** HTTP status when the client surfaces one (5xx → transient). */
  status?: number;
} | null | undefined;

export type MapDbErrorOptions = {
  /** Short label for logs, e.g. "admin-camps.create". */
  context?: string;
  /** Default true. Tests can pass false when asserting pure mapping. */
  log?: boolean;
  /**
   * Domain-flavoured generic fallback when nothing matches.
   * Registration uses a registration-specific sentence; desks use a load sentence.
   */
  fallback?: string;
};

/** Safe UI categories for structured logging and copy selection (#60). */
export type PublicErrorCategory =
  | "permission"
  | "not_found"
  | "validation"
  | "conflict"
  | "capacity"
  | "duplicate"
  | "timeout"
  | "transient"
  | "unknown";

export type ClassifiedOperationError = {
  /** True only for explicit transient classes (allow-list). */
  retryable: boolean;
  publicCategory: PublicErrorCategory;
  /** Camp-worker safe sentence — never raw Postgres text. */
  publicMessage: string;
  /** SQLSTATE / PostgREST / domain code for logs. */
  logCode: string | undefined;
  /** Original message text (for duplicate parsers; not for UI). */
  rawMessage: string;
};

export type ClassifyOperationErrorOptions = MapDbErrorOptions & {
  /**
   * Caller observed a transport failure (thrown fetch, offline, etc.).
   * Always treated as retryable when set.
   */
  transportFailure?: boolean;
  /**
   * Request aborted / timed out before a business response.
   * Retryable when the operation is idempotent (desk mutations are).
   */
  timedOut?: boolean;
};

const DEFAULT_FALLBACK =
  "Something went wrong. Try again or ask the desk.";

/** Explicit transient SQLSTATE / PostgREST codes (allow-list). */
const RETRYABLE_CODES = new Set([
  // Class 08 — connection exception
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  // Serialization / deadlock (safe transaction rollback)
  "40001",
  "40P01",
  // Statement timeout / cancel; cannot_connect_now
  "57014",
  "57P03",
  // Resource exhaustion that may clear
  "53300",
]);

function rawParts(error: DbErrorLike | string): {
  message: string;
  code: string;
  details: string;
  hint: string;
  status: number | undefined;
} {
  if (typeof error === "string") {
    return { message: error, code: "", details: "", hint: "", status: undefined };
  }
  const statusRaw = error?.status;
  const status =
    typeof statusRaw === "number" && Number.isFinite(statusRaw)
      ? statusRaw
      : undefined;
  return {
    message: String(error?.message || ""),
    code: String(error?.code || ""),
    details: String(error?.details || ""),
    hint: String(error?.hint || ""),
    status,
  };
}

function normalizeErrorParts(
  error: DbErrorLike | string | unknown,
): ReturnType<typeof rawParts> {
  if (
    typeof error === "string" ||
    (error &&
      typeof error === "object" &&
      ("message" in error || "code" in error || "status" in error))
  ) {
    return rawParts(error as DbErrorLike | string);
  }
  if (error instanceof Error) {
    return rawParts(error.message);
  }
  return rawParts("");
}

/** Last-resort transport patterns when no structured code is present. */
function isTransportLikeMessage(message: string): boolean {
  return /failed to fetch|networkerror|network request failed|load failed|econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|connection (reset|refused|closed|terminated)|err_network|err_connection|err_internet|offline|net::err_/i.test(
    message,
  );
}

function isTimeoutLikeMessage(message: string): boolean {
  return /timed?\s*out|timeout|aborted|aborterror|the operation was aborted|canceling statement due to statement timeout/i.test(
    message,
  );
}

function isRetryableCode(code: string): boolean {
  if (!code) return false;
  if (RETRYABLE_CODES.has(code)) return true;
  // Entire SQLSTATE class 08 — connection exception
  if (code.startsWith("08")) return true;
  return false;
}

/** Log raw error server- or client-side; never skip when log is true. */
export function logDbError(
  error: DbErrorLike | string | unknown,
  context?: string,
  extra?: { category?: PublicErrorCategory; retryable?: boolean },
): void {
  const parts = normalizeErrorParts(error);
  console.error("[db-error]", context || "unknown", {
    code: parts.code || undefined,
    message: parts.message || undefined,
    details: parts.details || undefined,
    hint: parts.hint || undefined,
    status: parts.status,
    category: extra?.category,
    retryable: extra?.retryable,
  });
}

/**
 * Pure classification: retry decision + safe public copy + log code (#60).
 * Allow-list for retryable; everything else is terminal.
 */
export function classifyOperationError(
  error: DbErrorLike | string | unknown,
  options: ClassifyOperationErrorOptions = {},
): ClassifiedOperationError {
  const {
    context,
    log = true,
    fallback = DEFAULT_FALLBACK,
    transportFailure = false,
    timedOut = false,
  } = options;

  const parts = normalizeErrorParts(error);
  const message = parts.message;
  const code = parts.code;
  const combined = `${message} ${parts.details} ${parts.hint}`;
  const logCode = code || undefined;

  // --- Public message resolution (mirrors prior mapDbError rules) ---
  let publicCategory: PublicErrorCategory = "unknown";
  let publicMessage: string | null = null;

  const aadhaarDup = message.match(/AADHAAR_DUPLICATE:reg=(\d+)/i);
  if (aadhaarDup) {
    publicCategory = "duplicate";
    publicMessage = `A registration with this name and Aadhaar last-4 already exists (reg no ${aadhaarDup[1]}). Ask the desk if this is a different person.`;
  }

  const likelyDup = message.match(/LIKELY_DUPLICATE:reg=(\d+)/i);
  if (!publicMessage && likelyDup) {
    publicCategory = "duplicate";
    // Keep raw for form actions when callers need the code; mapper still safe:
    publicMessage = `A similar registration may already exist (reg no ${likelyDup[1]}). Confirm before creating another.`;
  }

  if (!publicMessage && (code === "23505" || /duplicate key|unique constraint/i.test(combined))) {
    publicCategory = "conflict";
    publicMessage = /already registered/i.test(combined)
      ? "A matching registration already exists for this camp."
      : "That record already exists.";
  }
  if (!publicMessage && (code === "23503" || /foreign key|violates foreign key/i.test(combined))) {
    publicCategory = "validation";
    publicMessage = "Related data is missing or still in use.";
  }
  if (!publicMessage && (code === "23514" || /check constraint/i.test(combined))) {
    publicCategory = "validation";
    publicMessage = "That value is not allowed. Check the form and try again.";
  }
  if (
    !publicMessage &&
    (code === "42501" ||
      code === "PGRST301" ||
      code === "PGRST302" ||
      /permission denied|row-level security|rls|not authorized|JWT/i.test(combined))
  ) {
    publicCategory = "permission";
    publicMessage = "You do not have permission for this action.";
  }
  if (!publicMessage && (code === "22P02" || /invalid input syntax/i.test(combined))) {
    publicCategory = "validation";
    publicMessage = "Some of the entered data is not valid. Check and try again.";
  }
  if (
    !publicMessage &&
    (code === "PGRST116" || /results contain 0 rows|JSON object requested/i.test(combined))
  ) {
    publicCategory = "not_found";
    publicMessage = "That record was not found.";
  }
  if (
    !publicMessage &&
    (code === "57014" || /statement timeout|canceling statement/i.test(combined))
  ) {
    publicCategory = "timeout";
    publicMessage = "The request took too long. Try again.";
  }

  // Camp / registration domain phrases from RPC raise messages (copy only)
  if (!publicMessage && /day is full|select a camp day/i.test(message)) {
    publicCategory = "capacity";
    publicMessage = "That camp day is full. Choose another day.";
  }
  const belowMatch = message.match(
    /(?:SEAT_LIMIT_BELOW_ASSIGNED:taken|THEATRE_CAPACITY_BELOW_RESERVED:reserved)=(\d+)|Cannot set seats below taken \((\d+)\)/i,
  );
  if (!publicMessage && belowMatch) {
    const n = belowMatch[1] || belowMatch[2];
    publicCategory = "capacity";
    publicMessage = message.includes("THEATRE")
      ? `Theatre capacity cannot be below ${n} reserved OT slots`
      : `Seat limit cannot be below ${n} existing bookings`;
  }
  if (!publicMessage && /Theatre slot capacity reached|no theatre capacity remaining/i.test(message)) {
    publicCategory = "capacity";
    publicMessage = "Camp has no theatre capacity remaining";
  }
  if (!publicMessage && /already registered/i.test(message)) {
    publicCategory = "conflict";
    publicMessage = "A matching registration already exists for this camp.";
  }
  if (!publicMessage && /verification/i.test(message)) {
    publicCategory = "validation";
    publicMessage = "Verification expired. Verify again.";
  }
  if (!publicMessage && /active camp|invalid camp day|no longer active/i.test(message)) {
    publicCategory = "validation";
    publicMessage = "The selected camp or day is no longer available.";
  }
  if (!publicMessage && /phone/i.test(message) && /valid|invalid|format/i.test(message)) {
    publicCategory = "validation";
    publicMessage = "Enter a valid phone number, or leave phone blank at the desk.";
  }
  if (
    !publicMessage &&
    /seat|capacity|full/i.test(message) &&
    /day|camp|limit/i.test(message)
  ) {
    publicCategory = "capacity";
    publicMessage = "That camp day is full or the seat limit cannot be applied.";
  }
  if (!publicMessage && /not empty|has patients|cannot delete/i.test(message)) {
    publicCategory = "conflict";
    publicMessage = "Cannot delete while patients or related records still exist.";
  }
  // Schema cache / missing RPC — terminal, safe generic
  if (
    !publicMessage &&
    (code === "PGRST202" ||
      code === "PGRST204" ||
      code === "42883" ||
      code === "42P01" ||
      /could not find the function|schema cache|does not exist/i.test(combined))
  ) {
    publicCategory = "unknown";
    publicMessage = fallback;
  }

  if (!publicMessage) {
    publicCategory = "unknown";
    publicMessage = fallback;
  }

  // --- Retry allow-list (never invert to "retry everything except…") ---
  let retryable = false;

  if (transportFailure) {
    retryable = true;
    publicCategory = "transient";
  } else if (timedOut) {
    retryable = true;
    publicCategory = publicCategory === "unknown" ? "timeout" : publicCategory;
  } else if (typeof parts.status === "number" && parts.status >= 500) {
    retryable = true;
    publicCategory = "transient";
  } else if (isRetryableCode(code)) {
    retryable = true;
    if (code === "57014" || code.startsWith("57")) {
      publicCategory = "timeout";
    } else {
      publicCategory = "transient";
    }
  } else if (!code && isTransportLikeMessage(message)) {
    // Last-resort legacy / browser transport strings
    retryable = true;
    publicCategory = "transient";
  } else if (!code && isTimeoutLikeMessage(message)) {
    retryable = true;
    publicCategory = "timeout";
  }
  // P0001 / business raises / permission / validation / unknown → not retryable

  if (log) {
    logDbError(error, context, { category: publicCategory, retryable });
  }

  return {
    retryable,
    publicCategory,
    publicMessage,
    logCode,
    rawMessage: message,
  };
}

/**
 * Known Postgres / PostgREST codes and camp-specific message patterns → safe UI copy.
 * Unknown codes always return the fallback; raw text is logged, never returned.
 */
export function mapDbError(
  error: DbErrorLike | string | unknown,
  options: MapDbErrorOptions = {},
): string {
  return classifyOperationError(error, options).publicMessage;
}

/** True only when the error is on the transient allow-list (#60). */
export function isRetryableDbError(
  error: DbErrorLike | string | unknown,
  options: Pick<
    ClassifyOperationErrorOptions,
    "transportFailure" | "timedOut"
  > = {},
): boolean {
  return classifyOperationError(error, { ...options, log: false }).retryable;
}

/** Registration API helper — same mapper with registration-flavoured fallback. */
export function publicRegistrationError(
  error: DbErrorLike | string | unknown,
  context = "staff-register",
): string {
  return mapDbError(error, {
    context,
    fallback: "Registration failed. Try again or ask the desk.",
  });
}

/**
 * Map Supabase Auth / GoTrue provider errors to staff-safe copy (#63).
 * Known credential and rate-limit cases get specific sentences; everything
 * else logs raw text and returns a generic message — never provider internals.
 */
export function mapAuthError(
  error: DbErrorLike | string | unknown,
  options: MapDbErrorOptions & {
    /** Default: staff sign-in flavour. */
    kind?: "sign-in" | "change-password";
  } = {},
): string {
  const {
    context = options.kind === "change-password" ? "auth.change-password" : "auth.sign-in",
    log = true,
    kind = "sign-in",
    fallback =
      kind === "change-password"
        ? "Could not update password. Try again."
        : "Could not sign in. Check your connection and try again.",
  } = options;

  const parts = normalizeErrorParts(error);
  const message = parts.message;
  const lower = message.toLowerCase();
  const code = parts.code.toLowerCase();

  let publicMessage: string | null = null;

  if (
    code === "invalid_credentials" ||
    /invalid (login|credentials)|invalid email or password|wrong (email|password)|user not found/i.test(
      lower,
    )
  ) {
    publicMessage =
      kind === "change-password"
        ? "Could not update password. Check the new password and try again."
        : "Wrong email or password. Check and try again.";
  } else if (
    code === "email_not_confirmed" ||
    /email not confirmed|confirm your email/i.test(lower)
  ) {
    publicMessage =
      "This account is not ready yet. Ask an admin for help.";
  } else if (
    code === "user_banned" ||
    /user is banned|disabled|account.*disabled/i.test(lower)
  ) {
    publicMessage =
      "This staff account is unavailable. Ask an admin for help.";
  } else if (
    code === "over_request_rate_limit" ||
    code === "over_email_send_rate_limit" ||
    /rate limit|too many requests|email rate/i.test(lower)
  ) {
    publicMessage = "Too many attempts. Wait a moment and try again.";
  } else if (
    code === "weak_password" ||
    /password.*(weak|short|least|characters)/i.test(lower)
  ) {
    publicMessage =
      "Password is too weak. Use a longer password and try again.";
  } else if (
    code === "same_password" ||
    /same password|should be different/i.test(lower)
  ) {
    publicMessage = "Choose a password that is different from the current one.";
  } else if (/network|fetch failed|failed to fetch|offline/i.test(lower)) {
    publicMessage =
      kind === "change-password"
        ? "Could not update password. Check your connection and try again."
        : "Could not sign in. Check your connection and try again.";
  }

  if (!publicMessage) {
    publicMessage = fallback;
  }

  if (log) {
    logDbError(error, context, {
      category: publicMessage === fallback ? "unknown" : "validation",
      retryable: false,
    });
  }

  return publicMessage;
}
