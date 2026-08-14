import {
  classifyOperationError,
  type DbErrorLike,
} from "@/lib/public-error";

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
  aadhaarDuplicateOverride?: boolean;
  likelyDuplicateOverride?: boolean;
  provenance?: string | null;
  duplicateKey?: string | null;
  dateOfBirth?: string | null;
};

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
  retryable?: boolean;
  logCode?: string;
  publicCategory?: string;
};

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
