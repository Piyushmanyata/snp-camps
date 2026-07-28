import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureFakeAadhaarCamera } from "./fake-aadhaar-camera.mjs";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:3100";

function loadEnvLocal() {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return {};
  const content = readFileSync(envPath, "utf8");
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }
  return result;
}

function requireLoopback(value, name) {
  const url = new URL(value);
  if (!loopbackHosts.has(url.hostname)) {
    throw new Error(`${name} must be a loopback URL; remote E2E is disabled.`);
  }
}

function command(name, args) {
  return execFileSync(name, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function discoverDockerKeys() {
  try {
    const requested = process.env.E2E_SUPABASE_PROJECT_ID;
    const containers = command("docker", [
      "ps",
      "--filter",
      "name=supabase_storage_",
      "--format",
      "{{.Names}}",
    ])
      .split(/\r?\n/)
      .filter(Boolean);
    const matches = requested
      ? containers.filter((name) => name === `supabase_storage_${requested}`)
      : containers;

    if (matches.length !== 1) {
      return null;
    }

    const values = new Map(
      command("docker", [
        "inspect",
        "--format",
        "{{range .Config.Env}}{{println .}}{{end}}",
        matches[0],
      ])
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
    if (!anonKey || !serviceKey) {
      return null;
    }
    return { anonKey, serviceKey };
  } catch {
    return null;
  }
}

async function canReuseExistingServer() {
  try {
    const response = await fetch(baseURL, { signal: AbortSignal.timeout(2_000) });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

requireLoopback(baseURL, "E2E_BASE_URL");

const envLocal = loadEnvLocal();

let discovered = null;
if (!process.env.E2E_SUPABASE_ANON_KEY || !process.env.E2E_SUPABASE_SERVICE_ROLE_KEY) {
  discovered = discoverDockerKeys();
}


const hasValidServiceKey = Boolean(envLocal.SUPABASE_SERVICE_ROLE_KEY);

const finalSupabaseURL =
  process.env.E2E_SUPABASE_URL ||
  (discovered
    ? "http://127.0.0.1:54321"
    : hasValidServiceKey && envLocal.NEXT_PUBLIC_SUPABASE_URL
    ? envLocal.NEXT_PUBLIC_SUPABASE_URL
    : "http://127.0.0.1:54321");

const finalAnonKey =
  process.env.E2E_SUPABASE_ANON_KEY ||
  (discovered
    ? discovered.anonKey
    : hasValidServiceKey && (envLocal.NEXT_PUBLIC_SUPABASE_ANON_KEY || envLocal.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
    ? (envLocal.NEXT_PUBLIC_SUPABASE_ANON_KEY || envLocal.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
    : "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IjEyNy4wLjAuMSIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNjQwOTk1MjAwLCJleHAiOjE5NTY1NzEyMDB9.P3BvYt6D2y0_5Z6aM5Y4Y-gX00_P5aW4c5v6B7n8M90");

const finalServiceKey =
  process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ||
  (discovered
    ? discovered.serviceKey
    : hasValidServiceKey && envLocal.SUPABASE_SERVICE_ROLE_KEY
    ? envLocal.SUPABASE_SERVICE_ROLE_KEY
    : "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IjEyNy4wLjAuMSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUiLCJpYXQiOjE2NDA5OTUyMDAsImV4cCI6MTk1NjU3MTIwMH0.v0vP9yX8kL1mN2oP3qR4sT5uV6wX7yZ8aB9c0d1e2f3");

// Prefer a clean production server for #71 island network asserts. Reuse only
// when the operator explicitly opts in — a leftover `next dev` or a build that
// baked remote NEXT_PUBLIC_* from .env.local will break local E2E auth.
const useProduction = process.env.E2E_PRODUCTION !== "0";
const reuseExistingServer =
  process.env.E2E_REUSE_SERVER === "1" ? await canReuseExistingServer() : false;

const e2ePublicEnv = {
  NEXT_PUBLIC_SUPABASE_URL: finalSupabaseURL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: finalAnonKey,
  SUPABASE_SERVICE_ROLE_KEY: finalServiceKey,
  NEXT_PUBLIC_SITE_URL: baseURL,
};

// Production client bundles inline NEXT_PUBLIC_* at build time. Always rebuild
// with the E2E Supabase project (local Docker / keys) so sign-in hits the same
// host global-setup provisioned — not a remote URL from .env.local.
if (useProduction && !reuseExistingServer) {
  const build = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build"],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...e2ePublicEnv },
      stdio: "inherit",
      shell: true,
    },
  );
  if (build.status !== 0) {
    process.exitCode = build.status ?? 1;
    throw new Error("Production build for E2E failed (NEXT_PUBLIC_* must match E2E Supabase)");
  }
  // Refresh route-chunk-map for island-split asserts against this build.
  if (existsSync(join(process.cwd(), "scripts", "check-js-budget.mjs"))) {
    spawnSync(process.execPath, ["scripts/check-js-budget.mjs", "--print"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
  }
}

const env = {
  ...process.env,
  E2E_LOCAL_READY: "1",
  E2E_BASE_URL: baseURL,
  E2E_SUPABASE_URL: finalSupabaseURL,
  E2E_SUPABASE_ANON_KEY: finalAnonKey,
  E2E_SUPABASE_SERVICE_ROLE_KEY: finalServiceKey,
  ...e2ePublicEnv,
  E2E_REUSE_SERVER: reuseExistingServer ? "1" : "0",
  E2E_PRODUCTION: useProduction ? "1" : "0",
  PLAYWRIGHT_HTML_OPEN: "never",
  E2E_FAKE_CAMERA_PATH: ensureFakeAadhaarCamera(),
};

const require = createRequire(import.meta.url);
const playwrightCli = require.resolve("@playwright/test/cli");
const result = spawnSync(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
