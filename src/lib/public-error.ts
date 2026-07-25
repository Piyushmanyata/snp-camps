/**
 * Map database / PostgREST errors to camp-worker copy.
 * Always log the raw error (with optional context) so operators can debug;
 * never surface Postgres text to the UI.
 */

export type DbErrorLike = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
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

const DEFAULT_FALLBACK =
  "Something went wrong. Try again or ask the desk.";

function rawParts(error: DbErrorLike | string): {
  message: string;
  code: string;
  details: string;
  hint: string;
} {
  if (typeof error === "string") {
    return { message: error, code: "", details: "", hint: "" };
  }
  return {
    message: String(error?.message || ""),
    code: String(error?.code || ""),
    details: String(error?.details || ""),
    hint: String(error?.hint || ""),
  };
}

/** Log raw error server- or client-side; never skip when log is true. */
export function logDbError(
  error: DbErrorLike | string | unknown,
  context?: string,
): void {
  const parts =
    typeof error === "string" ||
    (error && typeof error === "object" && ("message" in error || "code" in error))
      ? rawParts(error as DbErrorLike | string)
      : {
          message: error instanceof Error ? error.message : String(error ?? ""),
          code: "",
          details: "",
          hint: "",
        };
  console.error("[db-error]", context || "unknown", {
    code: parts.code || undefined,
    message: parts.message || undefined,
    details: parts.details || undefined,
    hint: parts.hint || undefined,
  });
}

/**
 * Known Postgres / PostgREST codes and camp-specific message patterns → safe UI copy.
 * Unknown codes always return the fallback; raw text is logged, never returned.
 */
export function mapDbError(
  error: DbErrorLike | string | unknown,
  options: MapDbErrorOptions = {},
): string {
  const { context, log = true, fallback = DEFAULT_FALLBACK } = options;

  if (log) {
    logDbError(error, context);
  }

  const parts =
    typeof error === "string" ||
    (error && typeof error === "object" && ("message" in error || "code" in error))
      ? rawParts(error as DbErrorLike | string)
      : error instanceof Error
        ? rawParts(error.message)
        : rawParts("");

  const message = parts.message;
  const code = parts.code;
  const combined = `${message} ${parts.details} ${parts.hint}`;

  // Registration-specific: keep structured Aadhaar copy for desk staff.
  const aadhaarDup = message.match(/AADHAAR_DUPLICATE:reg=(\d+)/i);
  if (aadhaarDup) {
    return `A registration with this name and Aadhaar last-4 already exists (reg no ${aadhaarDup[1]}). Ask the desk if this is a different person.`;
  }

  // Postgres SQLSTATE / PostgREST codes
  if (code === "23505" || /duplicate key|unique constraint/i.test(combined)) {
    // Only the RPC phrase "already registered" is registration-specific.
    if (/already registered/i.test(combined)) {
      return "A matching registration already exists for this camp.";
    }
    return "That record already exists.";
  }
  if (code === "23503" || /foreign key|violates foreign key/i.test(combined)) {
    return "Related data is missing or still in use.";
  }
  if (code === "23514" || /check constraint/i.test(combined)) {
    return "That value is not allowed. Check the form and try again.";
  }
  if (
    code === "42501" ||
    code === "PGRST301" ||
    /permission denied|row-level security|rls|not authorized|JWT/i.test(combined)
  ) {
    return "You do not have permission for this action.";
  }
  if (code === "22P02" || /invalid input syntax/i.test(combined)) {
    return "Some of the entered data is not valid. Check and try again.";
  }
  if (code === "PGRST116" || /results contain 0 rows|JSON object requested/i.test(combined)) {
    return "That record was not found.";
  }
  if (code === "57014" || /statement timeout|canceling statement/i.test(combined)) {
    return "The request took too long. Try again.";
  }

  // Camp / registration domain phrases from RPC raise messages
  if (/day is full|select a camp day/i.test(message)) {
    return "That camp day is full. Choose another day.";
  }
  if (/already registered/i.test(message)) {
    return "A matching registration already exists for this camp.";
  }
  if (/verification/i.test(message)) {
    return "Verification expired. Verify again.";
  }
  if (/active camp|invalid camp day/i.test(message)) {
    return "The selected camp or day is no longer available.";
  }
  if (/phone/i.test(message) && /valid|invalid|format/i.test(message)) {
    return "Enter a valid phone number, or leave phone blank at the desk.";
  }
  if (/seat|capacity|full/i.test(message) && /day|camp|limit/i.test(message)) {
    return "That camp day is full or the seat limit cannot be applied.";
  }
  if (/not empty|has patients|cannot delete/i.test(message)) {
    return "Cannot delete while patients or related records still exist.";
  }

  return fallback;
}

/** Registration API helper — same mapper with registration-flavoured fallback. */
export function publicRegistrationError(
  error: DbErrorLike | string | unknown,
  context = "patient-register",
): string {
  return mapDbError(error, {
    context,
    fallback: "Registration failed. Try again or ask the desk.",
  });
}
