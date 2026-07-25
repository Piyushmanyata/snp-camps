import { expect, test, type Page } from "@playwright/test";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E global setup.`);
  return value;
}

async function gotoHydrated(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

async function loginStaff(page: Page, role: "admin" | "volunteer") {
  await gotoHydrated(page, "/login");
  await page.getByLabel("Email").fill(env(`E2E_${role.toUpperCase()}_EMAIL`));
  await page
    .getByLabel("Password")
    .fill(env(`E2E_${role.toUpperCase()}_PASSWORD`));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/${role}$`));
}

async function blockRemoteRequests(page: Page) {
  const allowedHosts = new Set([
    ...loopbackHosts,
    ...(process.env.E2E_SUPABASE_URL
      ? [new URL(process.env.E2E_SUPABASE_URL).hostname]
      : []),
    ...(process.env.NEXT_PUBLIC_SUPABASE_URL
      ? [new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname]
      : []),
  ]);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !allowedHosts.has(url.hostname)
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

test.beforeEach(async ({ page, context }) => {
  await context.clearCookies();
  await blockRemoteRequests(page);
});

test("print sheet shows login passcode from sessionStorage and has no hydration warning", async ({
  page,
}) => {
  const patientId = env("E2E_PATIENT_ID");
  const passcode = "AB12CD";
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await loginStaff(page, "volunteer");

  await page.evaluate(
    ({ id, code }) => {
      sessionStorage.setItem(`snp-desk-passcode:${id}`, code);
    },
    { id: patientId, code: passcode },
  );

  await gotoHydrated(page, `/print/${patientId}`);
  await expect(page.getByText("Login passcode")).toBeVisible();
  await expect(page.getByText(passcode, { exact: true })).toBeVisible();

  const hydration = consoleErrors.filter((t) =>
    /hydrat/i.test(t),
  );
  expect(hydration, `unexpected console: ${consoleErrors.join(" | ")}`).toEqual(
    [],
  );
});

test("print sheet omits login passcode when sessionStorage has none", async ({
  page,
}) => {
  const patientId = env("E2E_PATIENT_ID");

  await loginStaff(page, "volunteer");
  await page.evaluate((id) => {
    sessionStorage.removeItem(`snp-desk-passcode:${id}`);
  }, patientId);

  await gotoHydrated(page, `/print/${patientId}`);
  await expect(page.getByText("Login passcode")).toHaveCount(0);
});
