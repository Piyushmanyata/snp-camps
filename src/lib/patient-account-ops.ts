/**
 * Patient Auth provisioning and passcode issue (ADR 0001, issue #17).
 *
 * Provision: ensure Auth user exists + patient.user_id linked. No secret.
 * Issue: set Auth password, stamp passcode_issued_at, return plaintext once.
 *
 * Concurrency: conditional UPDATE ... WHERE user_id IS NULL.
 * Never delete an Auth user on any failure path.
 */

import { generatePatientPassword } from "@/lib/patient-password";
import { passcodeIssuedPatchOnAuthWrite } from "@/lib/passcode-issued";

export type PatientAccountRow = {
  id: string;
  reg_no: number;
  full_name: string | null;
  user_id: string | null;
  phone: string | null;
  passcode_issued_at?: string | null;
};

/**
 * Service-role client surface used by provision/issue.
 * Typed loosely so unit tests can inject fakes without mirroring PostgREST builders.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PatientAccountAdmin = any;

export type ProvisionResult =
  | { ok: true; userId: string }
  | { ok: false; error: string; status: number };

export type IssueResult =
  | {
      ok: true;
      userId: string;
      password: string;
      regNo: number;
      email: string;
    }
  | { ok: false; error: string; status: number };

function alreadyExistsMessage(message: string) {
  return /already|registered|exists/i.test(message);
}

/** Resolve Auth user id for the deterministic patient email. */
export async function findAuthUserIdByEmail(
  admin: PatientAccountAdmin,
  email: string,
): Promise<string | null> {
  const { data: profile } = await admin
    .from("profiles")
    .select("id, role")
    .eq("email", email)
    .maybeSingle();
  if (profile?.id && typeof profile.id === "string") {
    return profile.id;
  }

  const { data: listed, error } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (error || !listed?.users) return null;
  const match = listed.users.find(
    (u: { id: string; email?: string }) =>
      u.email?.toLowerCase() === email.toLowerCase(),
  );
  return match?.id ?? null;
}

/**
 * Ensure Auth user exists and patient.user_id is linked.
 * Idempotent; never returns a password; never deletes Auth users.
 */
export async function provisionPatientAccount(
  admin: PatientAccountAdmin,
  patient: PatientAccountRow,
  opts: { email: string; name: string; regNo: number },
): Promise<ProvisionResult> {
  if (patient.user_id) {
    return { ok: true, userId: patient.user_id };
  }

  const { email, name, regNo } = opts;
  let userId: string | null = null;

  // Temporary password only so createUser succeeds; issue path sets the real one.
  const bootstrapPassword = generatePatientPassword();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: bootstrapPassword,
    email_confirm: true,
    user_metadata: { full_name: name, patient_reg_no: regNo },
  });

  if (createErr) {
    if (alreadyExistsMessage(createErr.message)) {
      userId = await findAuthUserIdByEmail(admin, email);
      if (!userId) {
        return {
          ok: false,
          error:
            "A login already exists for this reg no but could not be resolved. Try again.",
          status: 400,
        };
      }
    } else {
      return {
        ok: false,
        error: "Patient login could not be created. Try again.",
        status: 400,
      };
    }
  } else {
    userId = created.user?.id ?? null;
    if (!userId) {
      return { ok: false, error: "No user created", status: 400 };
    }
  }

  const { error: profileError } = await admin.from("profiles").upsert({
    id: userId,
    role: "patient",
    full_name: name,
    email,
    phone: patient.phone,
  });
  if (profileError) {
    // Do not delete the Auth user — leave it for a safe retry.
    return {
      ok: false,
      error: "Patient login could not be provisioned. Try again.",
      status: 500,
    };
  }

  const { data: linked, error: linkErr } = await admin
    .from("patients")
    .update({ user_id: userId })
    .eq("id", patient.id)
    .is("user_id", null)
    .select("id")
    .maybeSingle();

  if (linkErr) {
    return {
      ok: false,
      error: "Patient login could not be linked. Try again.",
      status: 400,
    };
  }

  if (!linked) {
    // Another request won the conditional update — success if linked; never delete.
    const { data: current, error: readErr } = await admin
      .from("patients")
      .select("user_id")
      .eq("id", patient.id)
      .maybeSingle();
    if (readErr) {
      return {
        ok: false,
        error: "Patient login could not be verified. Try again.",
        status: 500,
      };
    }
    const winnerId =
      current?.user_id && typeof current.user_id === "string"
        ? current.user_id
        : null;
    if (winnerId) {
      return { ok: true, userId: winnerId };
    }
    return {
      ok: false,
      error: "Patient login could not be linked. Try again.",
      status: 409,
    };
  }

  return { ok: true, userId };
}

/**
 * Set a fresh Auth password and stamp passcode_issued_at.
 * Caller must authorize Staff or the patient themselves.
 */
export async function issuePatientPasscode(
  admin: PatientAccountAdmin,
  patient: PatientAccountRow,
  opts: {
    email: string;
    name: string;
    regNo: number;
    password?: string;
  },
): Promise<IssueResult> {
  if (!patient.user_id) {
    return {
      ok: false,
      error: "Patient login is not provisioned yet.",
      status: 400,
    };
  }

  const userId = patient.user_id;
  const { data: userAuth, error: userAuthError } =
    await admin.auth.admin.getUserById(userId);
  if (userAuthError || !userAuth.user) {
    return {
      ok: false,
      error: "Patient login could not be loaded.",
      status: 500,
    };
  }

  const currentEmail = userAuth.user.email as string | undefined;
  const isOtpUser = Boolean(userAuth.user.phone);

  let emailToUpdate = opts.email;
  let regNoToReturn = opts.regNo;
  if (isOtpUser && currentEmail && currentEmail.startsWith("reg")) {
    emailToUpdate = currentEmail;
    const match = currentEmail.match(/^reg(\d+)@/);
    if (match?.[1]) {
      regNoToReturn = Number(match[1]);
    }
  }

  const password = opts.password || generatePatientPassword();
  const { error: updErr } = await admin.auth.admin.updateUserById(userId, {
    email: emailToUpdate,
    password,
    email_confirm: true,
  });
  if (updErr) {
    return {
      ok: false,
      error: "Patient login could not be updated.",
      status: 400,
    };
  }

  const stamp = passcodeIssuedPatchOnAuthWrite(true);
  if (stamp) {
    const { error: stampErr } = await admin
      .from("patients")
      .update(stamp)
      .eq("id", patient.id);
    if (stampErr) {
      // Password already written; stamp failure is non-fatal for login but
      // desk marker may lag until the next successful issue.
    }
  }

  const { error: profileError } = await admin
    .from("profiles")
    .update({
      role: "patient",
      full_name: opts.name,
      email: emailToUpdate,
    })
    .eq("id", userId);
  if (profileError) {
    return {
      ok: false,
      error: "Patient profile could not be updated.",
      status: 500,
    };
  }

  return {
    ok: true,
    userId,
    password,
    regNo: regNoToReturn,
    email: emailToUpdate,
  };
}
