import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const baseURL = process.env.E2E_BASE_URL || "http://localhost:3100";
const supabaseURL =
  process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";

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
    throw new Error(
      "Expected one running local Supabase stack. Set E2E_SUPABASE_PROJECT_ID to select it.",
    );
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
    throw new Error("The local Supabase container does not expose test keys.");
  }
  return { anonKey, serviceKey };
}

async function canReuseExistingServer() {
  let response;
  try {
    response = await fetch(baseURL, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return false;
  }

  const csp = response.headers.get("content-security-policy") || "";
  const localSupabaseOrigin = new URL(supabaseURL).origin;
  if (!csp.includes(localSupabaseOrigin)) {
    throw new Error(
      "The existing local app is not connected to the selected local Supabase stack. Stop it or use another E2E_BASE_URL.",
    );
  }
  return true;
}

requireLoopback(baseURL, "E2E_BASE_URL");
requireLoopback(supabaseURL, "E2E_SUPABASE_URL");

const discovered =
  process.env.E2E_SUPABASE_ANON_KEY &&
  process.env.E2E_SUPABASE_SERVICE_ROLE_KEY
    ? null
    : discoverDockerKeys();
const reuseExistingServer = await canReuseExistingServer();
const env = {
  ...process.env,
  E2E_LOCAL_READY: "1",
  E2E_BASE_URL: baseURL,
  E2E_SUPABASE_URL: supabaseURL,
  E2E_SUPABASE_ANON_KEY:
    process.env.E2E_SUPABASE_ANON_KEY || discovered?.anonKey,
  E2E_SUPABASE_SERVICE_ROLE_KEY:
    process.env.E2E_SUPABASE_SERVICE_ROLE_KEY || discovered?.serviceKey,
  E2E_REUSE_SERVER: reuseExistingServer ? "1" : "0",
  PLAYWRIGHT_HTML_OPEN: "never",
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
