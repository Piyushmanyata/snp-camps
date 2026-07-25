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

export type PublicRegistrationFields = {
  campId: string;
  campDayId: string;
  fullName: string;
  gender: string | null;
  age: number | null;
  address: string | null;
  phone: string;
  email: string | null;
  aadhaarLast4: string | null;
};

/** JSON body for POST /api/patient-register (public self-registration). */
export function publicRegistrationBody(
  attempt: Pick<RegistrationAttempt, "id">,
  fields: PublicRegistrationFields,
) {
  return {
    requestId: attempt.id,
    campId: fields.campId,
    campDayId: fields.campDayId,
    fullName: fields.fullName,
    gender: fields.gender,
    age: fields.age,
    address: fields.address,
    phone: fields.phone,
    email: fields.email,
    aadhaarLast4: fields.aadhaarLast4,
  };
}

export type StaffRegistrationFields = {
  campId: string;
  fullName: string;
  gender: string | null;
  age: number | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  aadhaarLast4: string | null;
  userId: string | null;
  createdBy: string | null;
  campDayId: string;
};

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
    p_user_id: fields.userId,
    p_created_by: fields.createdBy,
    p_camp_day_id: fields.campDayId,
  };
}

/**
 * Outbound registration call used by PatientForm.
 * Public path → fetch /api/patient-register; staff path → RPC.
 * Does not rotate the attempt — caller rotates only after success / resetForm.
 */
export async function submitRegistrationOutbound(options: {
  isStaff: boolean;
  attempt: Pick<RegistrationAttempt, "id">;
  publicFields?: PublicRegistrationFields;
  staffFields?: StaffRegistrationFields;
  fetchImpl?: typeof fetch;
  rpc?: (
    fn: "register_patient_idempotent",
    args: ReturnType<typeof staffRegistrationRpcArgs>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
}): Promise<{ data: unknown; error: string | null }> {
  const {
    isStaff,
    attempt,
    publicFields,
    staffFields,
    fetchImpl = fetch,
    rpc,
  } = options;

  if (isStaff) {
    if (!staffFields || !rpc) {
      return { data: null, error: "Staff registration is misconfigured." };
    }
    try {
      const result = await rpc(
        "register_patient_idempotent",
        staffRegistrationRpcArgs(attempt, staffFields),
      );
      return {
        data: result.data,
        error: result.error?.message || null,
      };
    } catch {
      return {
        data: null,
        error:
          "Registration service is unavailable. Check your connection and try again.",
      };
    }
  }

  if (!publicFields) {
    return { data: null, error: "Public registration is misconfigured." };
  }

  try {
    const response = await fetchImpl("/api/patient-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(publicRegistrationBody(attempt, publicFields)),
    });
    const payload = (await response.json()) as {
      patient?: unknown;
      error?: string;
    };
    return {
      data: payload.patient,
      error: response.ok ? null : payload.error || "Registration failed",
    };
  } catch {
    return {
      data: null,
      error:
        "Registration service is unavailable. Check your connection and try again.",
    };
  }
}
