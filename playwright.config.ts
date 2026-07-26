import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:3100";
const appUrl = new URL(baseURL);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

if (!loopbackHosts.has(appUrl.hostname)) {
  throw new Error("E2E_BASE_URL must be a loopback URL; remote E2E is disabled.");
}

if (process.env.E2E_LOCAL_READY !== "1") {
  throw new Error("Run the local-only suite with `npm run test:e2e`.");
}

const host = appUrl.hostname.replaceAll("[", "").replaceAll("]", "");
const port = appUrl.port || "3100";
// #71: optional-island network asserts need production chunks, not the
// development bundler. Default to `next start` after verify/build.
const useProductionServer = process.env.E2E_PRODUCTION !== "0";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: true,
  reporter: [["line"]],
  outputDir: ".playwright-cli/test-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: useProductionServer
      ? `npx next start --hostname ${host} --port ${port}`
      : `npm run dev -- --hostname ${host} --port ${port}`,
    url: baseURL,
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.E2E_SUPABASE_URL!,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.E2E_SUPABASE_ANON_KEY!,
      SUPABASE_SERVICE_ROLE_KEY: process.env.E2E_SUPABASE_SERVICE_ROLE_KEY!,
      NEXT_PUBLIC_SITE_URL: baseURL,
    },
  },
});
