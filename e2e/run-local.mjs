import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureFakeAadhaarCamera,
  ensureFakeAadhaarPhoto,
} from "./fake-aadhaar-camera.mjs";
import { readConfiguredProjectId } from "../scripts/run-db-tests.mjs";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const require = createRequire(import.meta.url);

export function requireLoopback(value, name) {
  const url = new URL(value);
  if (!loopbackHosts.has(url.hostname)) {
    throw new Error(`${name} must be a loopback URL; remote E2E is disabled.`);
  }
}

function defaultCommand(name, args) {
  return execFileSync(name, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseDockerEnv(text) {
  return new Map(
    String(text || "")
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator > 0
          ? [line.slice(0, separator), line.slice(separator + 1)]
          : [line, ""];
      }),
  );
}

function discoveryError(detail) {
  return new Error(
    [
      `E2E discovery failed: ${detail}`,
      "Set E2E_SUPABASE_PROJECT_ID to the supabase/config.toml project_id,",
      "or set E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY, and E2E_SUPABASE_SERVICE_ROLE_KEY together.",
      "Do not guess among local projects.",
    ].join(" "),
  );
}

export function resolveNpmCli({
  existsImpl = existsSync,
  requireImpl = require,
  execPath = process.execPath,
} = {}) {
  const bundled = join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsImpl(bundled)) return bundled;
  return requireImpl.resolve("npm/bin/npm-cli.js");
}

export function spawnProductionBuild({
  spawnSyncImpl = spawnSync,
  env = process.env,
  cwd = process.cwd(),
  npmCli = resolveNpmCli(),
} = {}) {
  return spawnSyncImpl(process.execPath, [npmCli, "run", "build"], {
    cwd,
    env,
    stdio: "inherit",
  });
}

export function discoverLocalSupabase({
  env = process.env,
  configuredProjectId = readConfiguredProjectId(),
  commandImpl = defaultCommand,
} = {}) {
  const explicitUrl = env.E2E_SUPABASE_URL;
  const explicitAnon = env.E2E_SUPABASE_ANON_KEY;
  const explicitService = env.E2E_SUPABASE_SERVICE_ROLE_KEY;
  const explicitCount = [explicitUrl, explicitAnon, explicitService].filter(Boolean)
    .length;
  if (explicitCount === 3) {
    requireLoopback(explicitUrl, "E2E_SUPABASE_URL");
    return {
      url: explicitUrl,
      anonKey: explicitAnon,
      serviceKey: explicitService,
      source: "env",
      projectId: env.E2E_SUPABASE_PROJECT_ID || configuredProjectId,
    };
  }
  if (explicitCount > 0) {
    throw discoveryError(
      "E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY, and E2E_SUPABASE_SERVICE_ROLE_KEY must be set together.",
    );
  }

  const requested = env.E2E_SUPABASE_PROJECT_ID || configuredProjectId;
  if (!requested) {
    throw discoveryError("supabase/config.toml project_id is missing.");
  }

  let namesText;
  try {
    namesText = commandImpl("docker", [
      "ps",
      "--filter",
      "name=supabase_kong_",
      "--format",
      "{{.Names}}",
    ]);
  } catch (err) {
    throw discoveryError(
      `docker inspect error (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  const containers = String(namesText || "")
    .split(/\r?\n/)
    .filter(Boolean);
  const matches = containers.filter((name) => name === `supabase_kong_${requested}`);
  if (matches.length !== 1) {
    throw discoveryError(
      `expected supabase_kong_${requested}, found ${containers.length ? containers.join(", ") : "none"}.`,
    );
  }

  let envMap;
  try {
    envMap = parseDockerEnv(
      commandImpl("docker", [
        "inspect",
        "--format",
        "{{range .Config.Env}}{{println .}}{{end}}",
        matches[0],
      ]),
    );
  } catch (err) {
    throw discoveryError(
      `could not inspect ${matches[0]} (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  let anonKey = envMap.get("ANON_KEY");
  let serviceKey = envMap.get("SERVICE_KEY");
  if (!anonKey || !serviceKey) {
    try {
      const storageEnv = parseDockerEnv(
        commandImpl("docker", [
          "inspect",
          "--format",
          "{{range .Config.Env}}{{println .}}{{end}}",
          `supabase_storage_${requested}`,
        ]),
      );
      anonKey = anonKey || storageEnv.get("ANON_KEY");
      serviceKey = serviceKey || storageEnv.get("SERVICE_KEY");
    } catch {
      /* keep */
    }
  }
  if (!anonKey || !serviceKey) {
    throw discoveryError(
      `container ${matches[0]} is missing ANON_KEY/SERVICE_KEY.`,
    );
  }

  let apiPort;
  try {
    const portText = commandImpl("docker", ["port", matches[0], "8000/tcp"]);
    apiPort = Number(String(portText).match(/:(\d+)/)?.[1]);
  } catch (err) {
    throw discoveryError(
      `could not read API port mapping for ${matches[0]} (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  if (!apiPort) {
    throw discoveryError(`could not read API port mapping for ${matches[0]}.`);
  }

  const url = `http://127.0.0.1:${apiPort}`;
  requireLoopback(url, "E2E_SUPABASE_URL");
  return {
    url,
    anonKey,
    serviceKey,
    source: "docker",
    projectId: requested,
    apiPort,
  };
}

export async function runLocalE2e({
  env = process.env,
  spawnSyncImpl = spawnSync,
  commandImpl = defaultCommand,
  configuredProjectId = readConfiguredProjectId(),
} = {}) {
  const baseURL = env.E2E_BASE_URL || "http://127.0.0.1:3100";
  requireLoopback(baseURL, "E2E_BASE_URL");

  const discovered = discoverLocalSupabase({
    env,
    configuredProjectId,
    commandImpl,
  });
  const finalSupabaseURL = discovered.url;
  const finalAnonKey = discovered.anonKey;
  const finalServiceKey = discovered.serviceKey;
  requireLoopback(finalSupabaseURL, "E2E_SUPABASE_URL");

  async function canReuseExistingServer() {
    try {
      const response = await fetch(baseURL, { signal: AbortSignal.timeout(2_000) });
      return response.ok || response.status < 500;
    } catch {
      return false;
    }
  }

  const useProduction = env.E2E_PRODUCTION !== "0";
  const reuseExistingServer =
    env.E2E_REUSE_SERVER === "1" ? await canReuseExistingServer() : false;

  const e2ePublicEnv = {
    NEXT_PUBLIC_SUPABASE_URL: finalSupabaseURL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: finalAnonKey,
    SUPABASE_SERVICE_ROLE_KEY: finalServiceKey,
    NEXT_PUBLIC_SITE_URL: baseURL,
    AADHAAR_HASH_PEPPER: "local-e2e-only-stable-person-key-pepper",
    MSG91_AUTH_KEY: "",
    MSG91_SENDER_ID: "",
    MSG91_TEMPLATE_REGISTRATION: "",
    MSG91_DLT_TE_ID_REGISTRATION: "",
    MSG91_TEMPLATE_REMINDER: "",
    MSG91_DLT_TE_ID_REMINDER: "",
  };

  if (useProduction && !reuseExistingServer) {
    const build = spawnProductionBuild({
      spawnSyncImpl,
      env: { ...env, ...e2ePublicEnv },
      cwd: process.cwd(),
    });
    if (build.status !== 0) {
      process.exitCode = build.status ?? 1;
      throw new Error(
        "Production build for E2E failed (NEXT_PUBLIC_* must match E2E Supabase)",
      );
    }
    if (existsSync(join(process.cwd(), "scripts", "check-js-budget.mjs"))) {
      spawnSyncImpl(process.execPath, ["scripts/check-js-budget.mjs", "--print"], {
        cwd: process.cwd(),
        env,
        stdio: "inherit",
      });
    }
  }

  const childEnv = {
    ...env,
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
    E2E_FAKE_AADHAAR_PHOTO_PATH: await ensureFakeAadhaarPhoto(),
  };

  const playwrightCli = require.resolve("@playwright/test/cli");
  const result = spawnSyncImpl(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runLocalE2e();
}
