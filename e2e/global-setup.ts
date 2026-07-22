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

function throwOnError(error: { message: string } | null, action: string) {
  if (error) throw new Error(`${action}: ${error.message}`);
}

async function listUsers(admin: SupabaseClient) {
  const users: User[] = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    throwOnError(error, "List local Auth users");
    users.push(...data.users);
    if (data.users.length < 1000) return users;
  }
}

async function removeStaleFixtures(admin: SupabaseClient) {
  const { error: patientError } = await admin
    .from("patients")
    .delete()
    .like("full_name", `${PATIENT_PREFIX}%`);
  throwOnError(patientError, "Remove stale E2E patients");

  for (const user of await listUsers(admin)) {
    if (
      user.email?.startsWith(USER_PREFIX) ||
      user.user_metadata?.e2e_suite === "snp-camps"
    ) {
      const { error } = await admin.auth.admin.deleteUser(user.id);
      throwOnError(error, "Remove stale E2E Auth user");
    }
  }

  const { data: camps, error: campsError } = await admin
    .from("camps")
    .select("id")
    .like("name", `${CAMP_PREFIX}%`);
  throwOnError(campsError, "Find stale E2E camps");
  for (const camp of camps || []) {
    const { error: dayError } = await admin
      .from("camp_days")
      .delete()
      .eq("camp_id", camp.id);
    throwOnError(dayError, "Remove stale E2E camp days");
    const { error: campError } = await admin.from("camps").delete().eq("id", camp.id);
    throwOnError(campError, "Remove stale E2E camp");
  }
}

export default async function globalSetup() {
  const supabaseURL = required("E2E_SUPABASE_URL");
  const host = new URL(supabaseURL).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    throw new Error("Supabase E2E setup is restricted to loopback URLs.");
  }

  const admin = createClient(
    supabaseURL,
    required("E2E_SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const userIds: string[] = [];
  let patientId: string | null = null;
  let createdDayId: string | null = null;
  let createdCampId: string | null = null;

  async function cleanup() {
    const errors: string[] = [];
    if (patientId) {
      const { error } = await admin.from("patients").delete().eq("id", patientId);
      if (error) errors.push(`patient: ${error.message}`);
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
    if (errors.length) throw new Error(`E2E cleanup failed: ${errors.join("; ")}`);
  }

  try {
    await removeStaleFixtures(admin);

    const createStaff = async (role: "admin" | "volunteer" | "doctor") => {
      const email = `${USER_PREFIX}${role}@snp.local`;
      const secret = password();
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: secret,
        email_confirm: true,
        user_metadata: {
          full_name: `Codex E2E ${role}`,
          e2e_suite: "snp-camps",
        },
      });
      throwOnError(error, `Create ${role} Auth user`);
      if (!data.user) throw new Error(`Create ${role} Auth user returned no user.`);
      userIds.push(data.user.id);
      const { error: profileError } = await admin
        .from("profiles")
        .upsert({ id: data.user.id, role, full_name: `Codex E2E ${role}`, email });
      throwOnError(profileError, `Set ${role} profile`);
      process.env[`E2E_${role.toUpperCase()}_EMAIL`] = email;
      process.env[`E2E_${role.toUpperCase()}_PASSWORD`] = secret;
      return data.user.id;
    };

    await createStaff("admin");
    const volunteerId = await createStaff("volunteer");
    await createStaff("doctor");

    const { data: activeCamp, error: campError } = await admin
      .from("camps")
      .select("id")
      .eq("is_active", true)
      .maybeSingle();
    throwOnError(campError, "Find active camp");
    let camp = activeCamp;
    if (!camp) {
      const created = await admin
        .from("camps")
        .insert({ name: `${CAMP_PREFIX} ${Date.now()}`, is_active: true })
        .select("id")
        .single();
      throwOnError(created.error, "Create E2E camp");
      if (!created.data) throw new Error("Create E2E camp returned no camp.");
      camp = created.data;
      createdCampId = created.data.id;
    }
    if (!camp) throw new Error("E2E camp setup returned no camp.");

    const { data: firstDay, error: dayError } = await admin
      .from("camp_days")
      .select("id")
      .eq("camp_id", camp.id)
      .order("day_date")
      .limit(1)
      .maybeSingle();
    throwOnError(dayError, "Find camp day");
    let day = firstDay;
    if (!day) {
      const dayDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const created = await admin
        .from("camp_days")
        .insert({ camp_id: camp.id, day_date: dayDate, seat_limit: 100 })
        .select("id")
        .single();
      throwOnError(created.error, "Create E2E camp day");
      if (!created.data) throw new Error("Create E2E camp day returned no day.");
      day = created.data;
      createdDayId = created.data.id;
    }
    if (!day) throw new Error("E2E camp-day setup returned no day.");

    const phone = `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
    const latestPatient = await admin
      .from("patients")
      .select("reg_no")
      .order("reg_no", { ascending: false })
      .limit(1)
      .maybeSingle();
    throwOnError(latestPatient.error, "Find next E2E registration number");
    const regNo = Number(latestPatient.data?.reg_no ?? 999) + 1;
    const insertedPatient = await admin
      .from("patients")
      .insert({
        camp_id: camp.id,
        camp_day_id: day.id,
        reg_no: regNo,
        full_name: `${PATIENT_PREFIX} ${Date.now()}`,
        gender: "O",
        age: 30,
        phone: `+91${phone}`,
        queue_status: "registered",
        created_by: volunteerId,
      })
      .select("id, reg_no, full_name")
      .single();
    throwOnError(insertedPatient.error, "Create E2E patient");
    const patient = insertedPatient.data;
    if (!patient) throw new Error("Create E2E patient returned no patient.");
    patientId = patient.id;

    const patientPassword = password();
    const patientEmail = `reg${patient.reg_no}@patients.snp.local`;
    const createdPatient = await admin.auth.admin.createUser({
      email: patientEmail,
      password: patientPassword,
      email_confirm: true,
      user_metadata: {
        full_name: patient.full_name,
        phone: `+91${phone}`,
        e2e_suite: "snp-camps",
      },
    });
    throwOnError(createdPatient.error, "Create patient Auth user");
    if (!createdPatient.data.user) {
      throw new Error("Create patient Auth user returned no user.");
    }
    userIds.push(createdPatient.data.user.id);
    const { error: patientProfileError } = await admin
      .from("profiles")
      .upsert({
        id: createdPatient.data.user.id,
        role: "patient",
        full_name: patient.full_name,
        email: patientEmail,
        phone: `+91${phone}`,
      });
    throwOnError(patientProfileError, "Set patient profile");
    const { error: linkError } = await admin
      .from("patients")
      .update({ user_id: createdPatient.data.user.id, email: patientEmail })
      .eq("id", patientId);
    throwOnError(linkError, "Link E2E patient account");

    process.env.E2E_PATIENT_REG_NO = String(patient.reg_no);
    process.env.E2E_PATIENT_PASSWORD = patientPassword;
    process.env.E2E_PATIENT_NAME = patient.full_name;

    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
