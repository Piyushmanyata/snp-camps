import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const containers = execFileSync(
  "docker",
  ["ps", "--filter", "name=supabase_storage_", "--format", "{{.Names}}"],
  { encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);

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
    .map((l) => {
      const i = l.indexOf("=");
      return i > 0 ? [l.slice(0, i), l.slice(i + 1)] : [l, ""];
    }),
);

const dockerAnon = values.get("ANON_KEY");
const dockerService = values.get("SERVICE_KEY");
const url = "http://127.0.0.1:54321";

const admin = createClient(url, dockerService, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const email = "codex-e2e-probe@snp.local";
const password = "ProbePass1!aaaaaaAa1!";

const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
for (const u of listed.data?.users || []) {
  if (u.email === email) await admin.auth.admin.deleteUser(u.id);
}

const created = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
console.log("create ok", !created.error, created.error?.message);

const client = createClient(url, dockerAnon, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const sign = await client.auth.signInWithPassword({ email, password });
console.log(
  "sign ok",
  !sign.error,
  sign.error?.message,
  sign.error?.code,
  sign.error?.status,
);

// Also try with env.local keys if different
const envLocal = {};
try {
  const { readFileSync } = await import("node:fs");
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) {
      let v = t.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      envLocal[t.slice(0, eq).trim()] = v;
    }
  }
} catch {
  /* */
}
const envAnon =
  envLocal.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  envLocal.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
console.log("env anon matches docker", envAnon === dockerAnon);
console.log(
  "env service matches docker",
  envLocal.SUPABASE_SERVICE_ROLE_KEY === dockerService,
);

if (created.data?.user) {
  await admin.auth.admin.deleteUser(created.data.user.id);
}
