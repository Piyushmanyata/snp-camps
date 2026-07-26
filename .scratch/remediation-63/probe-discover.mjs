import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

function discoverDockerKeys() {
  try {
    const containers = execFileSync(
      "docker",
      ["ps", "--filter", "name=supabase_storage_", "--format", "{{.Names}}"],
      { encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter(Boolean);
    console.log("containers", containers);
    if (containers.length !== 1) return null;
    const values = new Map(
      execFileSync(
        "docker",
        [
          "inspect",
          "--format",
          "{{range .Config.Env}}{{println .}}{{end}}",
          containers[0],
        ],
        { encoding: "utf8" },
      )
        .split(/\r?\n/)
        .map((line) => {
          const separator = line.indexOf("=");
          return separator > 0
            ? [line.slice(0, separator), line.slice(separator + 1)]
            : [line, ""];
        }),
    );
    const anonKey = values.get("ANON_KEY");
    const serviceKey = values.get("SERVICE_KEY");
    if (!anonKey || !serviceKey) return null;
    return { anonKey, serviceKey };
  } catch (e) {
    console.error("discover failed", e);
    return null;
  }
}

const discovered = discoverDockerKeys();
console.log("discovered", Boolean(discovered));

const admin = createClient(
  "http://127.0.0.1:54321",
  discovered.serviceKey,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Mimic remove + create e2e volunteer
const email = "codex-e2e-volunteer@snp.local";
const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
console.log("list ok", !listed.error, "users", listed.data?.users?.length);
for (const u of listed.data?.users || []) {
  if (u.email?.startsWith("codex-e2e-")) {
    const del = await admin.auth.admin.deleteUser(u.id);
    console.log("delete", u.email, !del.error, del.error?.message);
  }
}

const password = "TestPass1!aaaaaaAa1!";
const created = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: "Codex E2E volunteer", e2e_suite: "snp-camps" },
});
console.log("create", !created.error, created.error?.message, created.data?.user?.id);

const client = createClient("http://127.0.0.1:54321", discovered.anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const sign = await client.auth.signInWithPassword({ email, password });
console.log("sign", !sign.error, sign.error?.message);

if (created.data?.user) {
  await admin
    .from("profiles")
    .upsert({
      id: created.data.user.id,
      role: "volunteer",
      full_name: "Codex E2E volunteer",
      email,
    });
  await admin.auth.admin.deleteUser(created.data.user.id);
}
