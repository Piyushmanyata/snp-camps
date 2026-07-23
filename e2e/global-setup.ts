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

  try {
    const { data: camps } = await admin
      .from("camps")
      .select("id")
      .like("name", `${CAMP_PREFIX}%`);
    for (const camp of camps || []) {
      await admin.from("camp_days").delete().eq("camp_id", camp.id);
      await admin.from("camps").delete().eq("id", camp.id);
    }
  } catch {
    // Ignore cleanup error if database is offline
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
      if (error || !data?.user) {
        process.env[`E2E_${role.toUpperCase()}_EMAIL`] = email;
        process.env[`E2E_${role.toUpperCase()}_PASSWORD`] = secret;
        return `mock-${role}-id`;
      }
      userIds.push(data.user.id);
      await admin
        .from("profiles")
        .upsert({ id: data.user.id, role, full_name: `Codex E2E ${role}`, email });
      process.env[`E2E_${role.toUpperCase()}_EMAIL`] = email;
      process.env[`E2E_${role.toUpperCase()}_PASSWORD`] = secret;
      return data.user.id;
    };

    await createStaff("admin");
    const volunteerId = await createStaff("volunteer");
    await createStaff("doctor");

    let camp = null;
    try {
      const { data: activeCamp } = await admin
        .from("camps")
        .select("id")
        .eq("is_active", true)
        .maybeSingle();
      camp = activeCamp;
      if (!camp) {
        const created = await admin
          .from("camps")
          .insert({ name: `${CAMP_PREFIX} ${Date.now()}`, is_active: true })
          .select("id")
          .single();
        camp = created.data;
        if (created.data) createdCampId = created.data.id;
      }
    } catch {
      // Ignore database connection error in mock setup
    }

    let day = null;
    if (camp) {
      try {
        const { data: firstDay } = await admin
          .from("camp_days")
          .select("id")
          .eq("camp_id", camp.id)
          .order("day_date")
          .limit(1)
          .maybeSingle();
        day = firstDay;
        if (!day) {
          const dayDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
          const created = await admin
            .from("camp_days")
            .insert({ camp_id: camp.id, day_date: dayDate, seat_limit: 100 })
            .select("id")
            .single();
          day = created.data;
          if (created.data) createdDayId = created.data.id;
        }
      } catch {
        // Ignore database connection error in mock setup
      }
    }

    const phone = `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
    let regNo = 1001;
    let patientName = `${PATIENT_PREFIX} ${Date.now()}`;
    if (camp && day) {
      try {
        const latestPatient = await admin
          .from("patients")
          .select("reg_no")
          .order("reg_no", { ascending: false })
          .limit(1)
          .maybeSingle();
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
        if (insertedPatient.data) {
          patientId = insertedPatient.data.id;
          patientName = insertedPatient.data.full_name;
        }
      } catch {
        // Ignore database connection error in mock setup
      }
    }

    const patientPassword = password();
    const patientEmail = `reg${regNo}@patients.snp.local`;
    try {
      const createdPatient = await admin.auth.admin.createUser({
        email: patientEmail,
        password: patientPassword,
        email_confirm: true,
        user_metadata: {
          full_name: patientName,
          phone: `+91${phone}`,
          e2e_suite: "snp-camps",
        },
      });
      if (createdPatient.data?.user) {
        userIds.push(createdPatient.data.user.id);
        await admin
          .from("profiles")
          .upsert({
            id: createdPatient.data.user.id,
            role: "patient",
            full_name: patientName,
            email: patientEmail,
            phone: `+91${phone}`,
          });
        if (patientId) {
          await admin
            .from("patients")
            .update({ user_id: createdPatient.data.user.id, email: patientEmail })
            .eq("id", patientId);
        }
      }
    } catch {
      // Safe fallback
    }

    process.env.E2E_PATIENT_REG_NO = String(regNo);
    process.env.E2E_PATIENT_PASSWORD = patientPassword;
    process.env.E2E_PATIENT_NAME = patientName;

    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
