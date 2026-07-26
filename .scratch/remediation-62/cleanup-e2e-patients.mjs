import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

function loadEnv() {
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m || process.env[m[1]]) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

loadEnv();
const url = process.env.E2E_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const patterns = [
  "E2E Print%",
  "E2E Retry%",
  "E2E Full%",
  "Codex E2E Patient Print%",
  "Codex E2E Patient Retry%",
  "Codex E2E Patient Full%",
];

for (const pattern of patterns) {
  const { data, error } = await admin
    .from("patients")
    .delete()
    .like("full_name", pattern)
    .select("id, full_name");
  console.log(pattern, { error: error?.message, deleted: data?.length ?? 0 });
}
