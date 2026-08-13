import {
  classifyOperationError,
  type DbErrorLike,
} from "@/lib/public-error";

/**
 * Stable idempotency key for one registration attempt.
 * Retries of the same walk-in reuse `id`; call `rotate()` after success or resetForm.
 * Pass `createRequestId` (or any UUID factory) — kept injectable so unit tests
 * do not depend on Node resolving TypeScript path/extension quirks.
 */
export type RegistrationAttempt = {
  readonly id: string;
  rotate(): void;
};

export function createRegistrationAttempt(
  createId: () => string,
): RegistrationAttempt {
  let id = createId();
  return {
    get id() {
      return id;
    },
    rotate() {
      id = createId();
    },
  };
}

export type StaffRegistrationFields = {
  campId: string;
  fullName: string;
  displayName?: string | null;
  gender: string | null;
  age: number | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  aadhaarLast4: string | null;
  createdBy: string | null;
  campDayId: string;
  /** Explicit one-shot Aadhaar last-4 + name duplicate override (staff only). */
  aadhaarDuplicateOverride?: boolean;
  /** Explicit one-shot soft-duplicate (name+age / phone) override (staff only). */
  likelyDuplicateOverride?: boolean;
  provenance?: string | null;
  duplicateKey?: string | null;
  dateOfBirth?: string | null;
};

/** Parse `AADHAAR_DUPLICATE:reg=N` from RPC / API error text. */
export function parseAadhaarDuplicateError(
  message: string | null | undefined,
): { regNo: number } | null {
  if (!message) return null;
  const m = message.match(/AADHAAR_DUPLICATE:reg=(\d+)/i);
  if (!m) return null;
  const regNo = Number(m[1]);
  if (!Number.isInteger(regNo) || regNo <= 0) return null;
  return { regNo };
}

/** Parse `LIKELY_DUPLICATE:reg=N` from soft-match warn (#48). */
export function parseLikelyDuplicateError(
  message: string | null | undefined,
): { regNo: number } | null {
  if (!message) return null;
  const m = message.match(/LIKELY_DUPLICATE:reg=(\d+)/i);
  if (!m) return null;
  const regNo = Number(m[1]);
  if (!Number.isInteger(regNo) || regNo <= 0) return null;
  return { regNo };
}

/** Args for supabase.rpc("register_patient_idempotent", …). */
export function staffRegistrationRpcArgs(
  attempt: Pick<RegistrationAttempt, "id">,
  fields: StaffRegistrationFields,
) {
  return {
    p_request_id: attempt.id,
    p_camp_id: fields.campId,
    p_full_name: fields.fullName,
    p_gender: fields.gender,
    p_age: fields.age,
    p_address: fields.address,
    p_phone: fields.phone,
    p_email: fields.email,
    p_aadhaar_last4: fields.aadhaarLast4,
    // p_user_id kept null: patient Auth ownership retired (#59).
    p_user_id: null,
    p_created_by: fields.createdBy,
    p_camp_day_id: fields.campDayId,
    p_aadhaar_duplicate_override: Boolean(fields.aadhaarDuplicateOverride),
    p_likely_duplicate_override: Boolean(fields.likelyDuplicateOverride),
    p_self_service: false,
    p_provenance: fields.provenance ?? "self_declared",
    p_duplicate_key: fields.duplicateKey ?? null,
    p_date_of_birth: fields.dateOfBirth ?? null,
    p_display_name: fields.displayName ?? null,
  };
}

export type RegistrationRpcError = NonNullable<DbErrorLike> & {
  message: string;
};

export type RegistrationSubmitResult = {
  data: unknown;
  error: string | null;
  aadhaarDuplicateRegNo?: number | null;
  likelyDuplicateRegNo?: number | null;
  /**
   * Explicit retry allow-list result from classifyOperationError (#60).
   * Undefined only for success / misconfiguration (not retryable).
   */
  retryable?: boolean;
  /** Structured code for logs (no PII). */
  logCode?: string;
  publicCategory?: string;
};

/**
 * Outbound registration call used by PatientForm.
 * Staff path only → RPC `register_patient_idempotent`.
 * The public `/self-register` flow uses its dedicated API boundary; this helper
 * remains the staff desk submission path used by `PatientForm`.
 * Does not rotate the attempt — caller rotates only after success / resetForm.
 */
export async function submitRegistrationOutbound(options: {
  isStaff: boolean;
  attempt: Pick<RegistrationAttempt, "id">;
  staffFields?: StaffRegistrationFields;
  rpc?: (
    fn: "register_patient_idempotent",
    args: ReturnType<typeof staffRegistrationRpcArgs>,
  ) => Promise<{ data: unknown; error: RegistrationRpcError | null }>;
}): Promise<RegistrationSubmitResult> {
  const { isStaff, attempt, staffFields, rpc } = options;

  if (!isStaff) {
    return {
      data: null,
      error: "Registration is at the camp desk only.",
      aadhaarDuplicateRegNo: null,
      likelyDuplicateRegNo: null,
      retryable: false,
    };
  }

  if (!staffFields || !rpc) {
    return {
      data: null,
      error: "Staff registration is misconfigured.",
      retryable: false,
    };
  }
  try {
    const result = await rpc(
      "register_patient_idempotent",
      staffRegistrationRpcArgs(attempt, staffFields),
    );
    const err = result.error;
    const errMsg = err?.message || null;
    const dup = parseAadhaarDuplicateError(errMsg);
    const soft = parseLikelyDuplicateError(errMsg);

    if (!errMsg) {
      return {
        data: result.data,
        error: null,
        aadhaarDuplicateRegNo: null,
        likelyDuplicateRegNo: null,
        retryable: false,
      };
    }

    // Keep AADHAAR_DUPLICATE / LIKELY_DUPLICATE raw so the form can offer actions.
    if (dup || soft) {
      return {
        data: result.data,
        error: errMsg,
        aadhaarDuplicateRegNo: dup?.regNo ?? null,
        likelyDuplicateRegNo: soft?.regNo ?? null,
        retryable: false,
        logCode: err?.code || (dup ? "AADHAAR_DUPLICATE" : "LIKELY_DUPLICATE"),
        publicCategory: "duplicate",
      };
    }

    const classified = classifyOperationError(err, {
      context: "staff-register.rpc",
      fallback: "Registration failed. Try again or ask the desk.",
    });
    return {
      data: result.data,
      error: classified.publicMessage,
      aadhaarDuplicateRegNo: null,
      likelyDuplicateRegNo: null,
      retryable: classified.retryable,
      logCode: classified.logCode,
      publicCategory: classified.publicCategory,
    };
  } catch (thrown) {
    const classified = classifyOperationError(thrown, {
      context: "staff-register.transport",
      transportFailure: true,
      fallback:
        "Registration service is unavailable. Check your connection and try again.",
    });
    return {
      data: null,
      error: classified.publicMessage,
      aadhaarDuplicateRegNo: null,
      likelyDuplicateRegNo: null,
      retryable: true,
      logCode: classified.logCode,
      publicCategory: "transient",
    };
  }
}
