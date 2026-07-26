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
    .map((line) => {
      const separator = line.indexOf("=");
      return separator > 0
        ? [line.slice(0, separator), line.slice(separator + 1)]
        : [line, ""];
    }),
);

const admin = createClient(
  "http://127.0.0.1:54321",
  values.get("SERVICE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
console.log("error", listed.error);
console.log("users count", listed.data?.users?.length);
console.log(
  "e2e emails",
  (listed.data?.users || [])
    .filter((u) => u.email?.includes("codex-e2e"))
    .map((u) => u.email),
);

// Fix: delete and recreate volunteer with known password
for (const u of listed.data?.users || []) {
  if (u.email?.startsWith("codex-e2e-")) {
    const del = await admin.auth.admin.deleteUser(u.id);
    console.log("deleted", u.email, del.error?.message || "ok");
  }
}

const listed2 = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
console.log("after cleanup e2e count", (listed2.data?.users || []).filter((u) => u.email?.includes("codex-e2e")).length);
