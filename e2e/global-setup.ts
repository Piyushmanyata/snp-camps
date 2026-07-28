import { randomBytes, randomInt } from "node:crypto";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

const USER_PREFIX = "codex-e2e-";
const PATIENT_PREFIX = "Codex E2E Patient";
const CAMP_PREFIX = "Codex E2E Camp";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for local E2E setup.`);
  return value;
}

function password() {
  return `${randomBytes(18).toString("base64url")}Aa1!`;
}

async function listUsers(admin: SupabaseClient) {
  const users: User[] = [];
  try {
    for (let page = 1; ; page += 1) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error || !data?.users) return users;
      users.push(...data.users);
      if (data.users.length < 1000) return users;
    }
  } catch {
    return users;
  }
}

async function removeStaleFixtures(admin: SupabaseClient) {
  try {
    await admin
      .from("patients")
      .delete()
      .like("full_name", `${PATIENT_PREFIX}%`);
    await admin
      .from("profiles")
      .delete()
      .like("email", `${USER_PREFIX}%`);
  } catch {
    // Ignore cleanup error if database is offline
  }

  for (const user of await listUsers(admin)) {
    if (
      user.email?.startsWith(USER_PREFIX) ||
      user.user_metadata?.e2e_suite === "snp-camps"
    ) {
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // Safe cleanup fallback
      }
    }
  }

  const staleCamps = await admin
    .from("camps")
    .select("id")
    .like("name", `${CAMP_PREFIX}%`);
  if (staleCamps.error) {
    throw new Error(`E2E stale Camp lookup failed: ${staleCamps.error.message}`);
  }
  for (const camp of staleCamps.data ?? []) {
    const patientRows = await admin
      .from("patients")
      .select("id, person_id")
      .eq("camp_id", camp.id);
    if (patientRows.error) {
      throw new Error(
        `E2E stale patient lookup failed: ${patientRows.error.message}`,
      );
    }
    const patientIds = (patientRows.data ?? []).map((row) => row.id);
    const personIds = [
      ...new Set(
        (patientRows.data ?? [])
          .map((row) => row.person_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const treatmentOrders = await admin
      .from("treatment_orders")
      .delete()
      .eq("camp_id", camp.id);
    if (treatmentOrders.error) {
      throw new Error(
        `E2E stale treatment cleanup failed: ${treatmentOrders.error.message}`,
      );
    }
    if (patientIds.length > 0) {
      const amendments = await admin
        .from("prescription_amendments")
        .delete()
        .in("patient_id", patientIds);
      if (amendments.error) {
        throw new Error(
          `E2E stale amendment cleanup failed: ${amendments.error.message}`,
        );
      }
      const prescriptions = await admin
        .from("prescriptions")
        .delete()
        .in("patient_id", patientIds);
      if (prescriptions.error) {
        throw new Error(
          `E2E stale prescription cleanup failed: ${prescriptions.error.message}`,
        );
      }
    }
    const patients = await admin
      .from("patients")
      .delete()
      .eq("camp_id", camp.id);
    if (patients.error) {
      throw new Error(`E2E stale patient cleanup failed: ${patients.error.message}`);
    }
    const days = await admin.from("camp_days").delete().eq("camp_id", camp.id);
    if (days.error) {
      throw new Error(`E2E stale day cleanup failed: ${days.error.message}`);
    }
    const campDelete = await admin.from("camps").delete().eq("id", camp.id);
    if (campDelete.error) {
      throw new Error(`E2E stale Camp cleanup failed: ${campDelete.error.message}`);
    }
    for (const personId of personIds) {
      const registrations = await admin
        .from("patients")
        .select("id", { count: "exact", head: true })
        .eq("person_id", personId);
      if (registrations.error) {
        throw new Error(
          `E2E stale Person check failed: ${registrations.error.message}`,
        );
      }
      if ((registrations.count ?? 0) === 0) {
        const person = await admin.from("persons").delete().eq("id", personId);
        if (person.error) {
          throw new Error(
            `E2E stale Person cleanup failed: ${person.error.message}`,
          );
        }
      }
    }
  }
}

export default async function globalSetup() {
  const supabaseURL = required("E2E_SUPABASE_URL");

  const serviceKey = required("E2E_SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseURL, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const userIds: string[] = [];
  let patientId: string | null = null;
  let doctorPatientId: string | null = null;
  let createdDayId: string | null = null;
  let createdCampId: string | null = null;
  let previousActiveCampId: string | null = null;

  async function cleanup() {
    const errors: string[] = [];
    if (createdCampId) {
      try {
        await admin.from("treatment_orders").delete().eq("camp_id", createdCampId);
        const { data: pRows } = await admin.from("patients").select("id").eq("camp_id", createdCampId);
        if (pRows && pRows.length > 0) {
          const pIds = pRows.map((r) => r.id);
          await admin.from("prescription_amendments").delete().in("patient_id", pIds);
          await admin.from("prescriptions").delete().in("patient_id", pIds);
        }
      } catch {
        // ignore if table/rows absent
      }
    }
    if (patientId) {
      await admin.from("treatment_orders").delete().eq("patient_id", patientId);
      await admin.from("prescription_amendments").delete().eq("patient_id", patientId);
      await admin.from("prescriptions").delete().eq("patient_id", patientId);
      const { error } = await admin.from("patients").delete().eq("id", patientId);
      if (error) errors.push(`patient: ${error.message}`);
    }
    if (doctorPatientId) {
      await admin.from("treatment_orders").delete().eq("patient_id", doctorPatientId);
      await admin.from("prescription_amendments").delete().eq("patient_id", doctorPatientId);
      await admin.from("prescriptions").delete().eq("patient_id", doctorPatientId);
      const { error } = await admin.from("patients").delete().eq("id", doctorPatientId);
      if (error) errors.push(`doctor patient: ${error.message}`);
    }
    // Desk register-print E2E may create extra patients on the fixture day/camp (#62).
    // Remove them (and any leftover prefix rows) before deleting day/camp FKs.
    try {
      const { error } = await admin
        .from("patients")
        .delete()
        .like("full_name", `${PATIENT_PREFIX}%`);
      if (error) errors.push(`prefix patients: ${error.message}`);
    } catch {
      // offline
    }
    if (createdDayId) {
      const { error: dayPatientsErr } = await admin
        .from("patients")
        .delete()
        .eq("camp_day_id", createdDayId);
      if (dayPatientsErr) errors.push(`day patients: ${dayPatientsErr.message}`);
    }
    if (createdCampId) {
      const { error: campPatientsErr } = await admin
        .from("patients")
        .delete()
        .eq("camp_id", createdCampId);
      if (campPatientsErr) {
        errors.push(`camp patients: ${campPatientsErr.message}`);
      }
    }
    for (const userId of userIds.reverse()) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error && !/not found/i.test(error.message)) {
        errors.push(`Auth user ${userId}: ${error.message}`);
      }
    }
    if (createdDayId) {
      const { error } = await admin.from("camp_days").delete().eq("id", createdDayId);
      if (error) errors.push(`camp day: ${error.message}`);
    }
    if (createdCampId) {
      const { error } = await admin.from("camps").delete().eq("id", createdCampId);
      if (error) errors.push(`camp: ${error.message}`);
    }
    if (previousActiveCampId) {
      const { error } = await admin
        .from("camps")
        .update({ is_active: true })
        .eq("id", previousActiveCampId);
      if (error) errors.push(`restore active camp: ${error.message}`);
    }
    if (errors.length) {
      // Disposable fixtures only — JWT/keyfunc flakes on delete must not fail a green suite.
      const fatal = errors.filter((e) => !/invalid JWT|unrecognized JWT|token is unverifiable/i.test(e));
      if (fatal.length) throw new Error(`E2E cleanup failed: ${fatal.join("; ")}`);
      console.warn(`E2E cleanup warnings (non-fatal): ${errors.join("; ")}`);
    }
  }

  try {
    await removeStaleFixtures(admin);

    const createStaff = async (
      role: "admin" | "team_lead" | "volunteer" | "doctor",
    ) => {
      const email = `${USER_PREFIX}${role}@snp.local`;
      const secret = password();
      const meta = {
        full_name: `Codex E2E ${role}`,
        e2e_suite: "snp-camps",
      };

      const created = await admin.auth.admin.createUser({
        email,
        password: secret,
        email_confirm: true,
        user_metadata: meta,
      });

      let userId = created.data?.user?.id ?? null;

      // Auth listUsers can 500; recover via profiles email when user already exists.
      if (!userId && /already|registered|exists/i.test(created.error?.message || "")) {
        const { data: existing } = await admin
          .from("profiles")
          .select("id")
          .eq("email", email)
          .maybeSingle();
        if (existing?.id) {
          const updated = await admin.auth.admin.updateUserById(existing.id, {
            password: secret,
            email_confirm: true,
            user_metadata: meta,
          });
          if (updated.error || !updated.data?.user) {
            throw new Error(
              `E2E createStaff(${role}) reset failed: ${updated.error?.message || "no user"}`,
            );
          }
          userId = updated.data.user.id;
        }
      }

      if (!userId) {
        throw new Error(
          `E2E createStaff(${role}) failed: ${created.error?.message || "no user"}`,
        );
      }

      userIds.push(userId);
      await admin
        .from("profiles")
        .upsert({ id: userId, role, full_name: `Codex E2E ${role}`, email });
      process.env[`E2E_${role.toUpperCase()}_EMAIL`] = email;
      process.env[`E2E_${role.toUpperCase()}_PASSWORD`] = secret;
      return userId;
    };

    await createStaff("admin");
    const volunteerId = await createStaff("volunteer");
    await createStaff("doctor");
    const teamLeadId = await createStaff("team_lead");
    const assignment = await admin
      .from("profiles")
      .update({ team_lead_id: teamLeadId })
      .eq("id", volunteerId);
    if (assignment.error) {
      throw new Error(
        `E2E Team Lead assignment failed: ${assignment.error.message}`,
      );
    }

    const activeCamp = await admin
      .from("camps")
      .select("id")
      .eq("is_active", true)
      .maybeSingle();
    if (activeCamp.error) {
      throw new Error(`E2E active Camp lookup failed: ${activeCamp.error.message}`);
    }
    previousActiveCampId = activeCamp.data?.id ?? null;
    if (previousActiveCampId) {
      const deactivated = await admin
        .from("camps")
        .update({ is_active: false })
        .eq("id", previousActiveCampId);
      if (deactivated.error) {
        throw new Error(
          `E2E active Camp isolation failed: ${deactivated.error.message}`,
        );
      }
    }

    const createdCamp = await admin
      .from("camps")
      .insert({
        name: `${CAMP_PREFIX} ${Date.now()}`,
        venue: "Local E2E",
        is_active: true,
      })
      .select("id")
      .single();
    if (createdCamp.error || !createdCamp.data) {
      throw new Error(
        `E2E Camp creation failed: ${createdCamp.error?.message || "no row"}`,
      );
    }
    const camp = createdCamp.data;
    createdCampId = camp.id;
    process.env.E2E_CAMP_ID = camp.id;

    const dayDate = new Date(Date.now() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const createdDay = await admin
      .from("camp_days")
      .insert({
        camp_id: camp.id,
        day_date: dayDate,
        seat_limit: 100,
        theatre_capacity: 20,
      })
      .select("id")
      .single();
    if (createdDay.error || !createdDay.data) {
      throw new Error(
        `E2E Camp day creation failed: ${createdDay.error?.message || "no row"}`,
      );
    }
    const day = createdDay.data;
    createdDayId = day.id;
    process.env.E2E_CAMP_DAY_ID = day.id;

    const phone = `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
    const doctorPatientPhone = `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
    let regNo = 1001;
    let patientName = `${PATIENT_PREFIX} ${Date.now()}`;
    let doctorRegNo = regNo + 1;
    let doctorPatientName = `${PATIENT_PREFIX} Doctor ${Date.now()}`;
    {
      const latestPatient = await admin
          .from("patients")
          .select("reg_no")
          .order("reg_no", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (latestPatient.error) {
          throw new Error(
            `E2E registration number lookup failed: ${latestPatient.error.message}`,
          );
        }
        regNo = Number(latestPatient.data?.reg_no ?? 999) + 1;
        const insertedPatient = await admin
          .from("patients")
          .insert({
            camp_id: camp.id,
            camp_day_id: day.id,
            reg_no: regNo,
            full_name: patientName,
            gender: "O",
            age: 30,
            phone: `+91${phone}`,
            queue_status: "registered",
            created_by: null,
          })
          .select("id, reg_no, full_name")
          .single();
        if (insertedPatient.error || !insertedPatient.data) {
          throw new Error(
            `E2E patient creation failed: ${insertedPatient.error?.message || "no row"}`,
          );
        }
        patientId = insertedPatient.data.id;
        patientName = insertedPatient.data.full_name;

        // Second patient for Doctor Station mark-seen mutation (#50).
        doctorRegNo = regNo + 1;
        doctorPatientName = `${PATIENT_PREFIX} Doctor ${Date.now()}`;
        const doctorPatient = await admin
          .from("patients")
          .insert({
            camp_id: camp.id,
            camp_day_id: day.id,
            reg_no: doctorRegNo,
            full_name: doctorPatientName,
            gender: "O",
            age: 40,
            phone: `+91${doctorPatientPhone}`,
            queue_status: "waiting",
            queued_at: new Date().toISOString(),
            created_by: null,
          })
          .select("id, reg_no, full_name")
          .single();
        if (doctorPatient.error || !doctorPatient.data) {
          throw new Error(
            `E2E doctor patient creation failed: ${doctorPatient.error?.message || "no row"}`,
          );
        }
        doctorPatientId = doctorPatient.data.id;
        doctorRegNo = doctorPatient.data.reg_no;
        doctorPatientName = doctorPatient.data.full_name;
    }

    // #59 — patients do not authenticate; no patient Auth/profile/user_id link.

    process.env.E2E_PATIENT_REG_NO = String(regNo);
    process.env.E2E_PATIENT_NAME = patientName;
    if (patientId) process.env.E2E_PATIENT_ID = patientId;
    process.env.E2E_DOCTOR_PATIENT_REG_NO = String(doctorRegNo);
    process.env.E2E_DOCTOR_PATIENT_NAME = doctorPatientName;
    if (doctorPatientId) process.env.E2E_DOCTOR_PATIENT_ID = doctorPatientId;

    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
