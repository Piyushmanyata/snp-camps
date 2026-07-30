import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function validateSupabaseProjectUrl(value, expectedRef) {
  if (!/^[a-z0-9]{20}$/.test(expectedRef)) {
    throw new Error("SUPABASE_PROJECT_REF must be a 20-character project ref");
  }

  const projectUrl = new URL(value);
  const expectedHost = `${expectedRef}.supabase.co`;
  const isExactProjectUrl =
    projectUrl.protocol === "https:" &&
    projectUrl.hostname === expectedHost &&
    projectUrl.port === "" &&
    projectUrl.username === "" &&
    projectUrl.password === "" &&
    projectUrl.pathname === "/" &&
    projectUrl.search === "" &&
    projectUrl.hash === "";
  if (!isExactProjectUrl) {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_URL must be exactly https://${expectedHost}`,
    );
  }

  return projectUrl.toString();
}

async function main() {
  const url = required("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const expectedRef = required("SUPABASE_PROJECT_REF");
  const email = required("ADMIN_BOOTSTRAP_EMAIL").toLowerCase();
  const password = required("ADMIN_BOOTSTRAP_PASSWORD");
  const fullName = required("ADMIN_BOOTSTRAP_NAME");

  validateSupabaseProjectUrl(url, expectedRef);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("ADMIN_BOOTSTRAP_EMAIL is invalid");
  }
  if (password.length < 14) {
    throw new Error("ADMIN_BOOTSTRAP_PASSWORD must be at least 14 characters");
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: existing, error: existingError } = await admin
    .from("profiles")
    .select("id")
    .eq("role", "admin")
    .limit(1);
  if (existingError) throw new Error("Could not verify existing administrators");
  if (existing?.length) {
    throw new Error("Bootstrap refused: an administrator already exists");
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (createError || !created.user) {
    throw new Error(createError?.message || "Could not create administrator");
  }

  const { error: profileError } = await admin.from("profiles").upsert({
    id: created.user.id,
    role: "admin",
    full_name: fullName,
    email,
    disabled_at: null,
  });
  if (profileError) {
    const { error: rollbackError } = await admin.auth.admin.deleteUser(
      created.user.id,
    );
    if (rollbackError) {
      throw new Error(
        `Administrator profile failed and Auth rollback failed; manually remove user ${created.user.id}`,
      );
    }
    throw new Error("Administrator profile failed; created Auth user was rolled back");
  }

  console.log(`Administrator created for ${email} in project ${expectedRef}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Bootstrap failed");
    process.exitCode = 1;
  });
}
