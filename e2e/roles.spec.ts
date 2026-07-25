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

async function loginStaff(page: Page, role: "admin" | "volunteer" | "doctor") {
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

test("public entry points and protected-route redirects", async ({
  page,
  request,
}) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBeTruthy();

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Medical Camp Desk" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Patient login/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Staff login/ })).toBeVisible();

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/volunteer");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/doctor");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/patient");
  await expect(page).toHaveURL(/\/patient\/login$/);
});

test("credential forms never put secrets in the URL before hydration", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await blockRemoteRequests(page);
  const marker = "e2e-no-js-password";

  await page.goto(`${env("E2E_BASE_URL")}/login`);
  await page.getByLabel("Email").fill("no-js@snp.local");
  await page.getByLabel("Password").fill(marker);
  await page.getByRole("button", { name: "Sign in" }).click();
  expect(page.url()).not.toContain(marker);
  expect(new URL(page.url()).search).toBe("");

  await page.goto(`${env("E2E_BASE_URL")}/patient/login`);
  await page.getByLabel("Registration number").fill("1234");
  if (await page.getByLabel("Password").isVisible().catch(() => false)) {
    await page.getByLabel("Password").fill(marker);
  }
  await page.getByRole("button", { name: "Sign in" }).click();
  expect(page.url()).not.toContain(marker);
  expect(new URL(page.url()).search).toBe("");

  await context.close();
});

test("admin can sign in, inspect the patient desk, and sign out", async ({
  page,
}) => {
  await loginStaff(page, "admin");
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await expect(
    page.getByText("Camps & camp days", { exact: true }),
  ).toBeVisible();

  await page.goto("/admin/patients");
  await expect(
    page.getByRole("heading", { name: "Patient desk" }),
  ).toBeVisible();
  await page.getByLabel("Filter list").fill(env("E2E_PATIENT_REG_NO"));
  await expect(
    page.getByText(`#${env("E2E_PATIENT_REG_NO")}`, { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("volunteer can sign in and safely review a patient", async ({ page }) => {
  await loginStaff(page, "volunteer");
  await expect(
    page.getByRole("heading", { name: "Volunteer desk" }),
  ).toBeVisible();

  await page.getByLabel("Reg no / QR link").fill(env("E2E_PATIENT_REG_NO"));
  await page.getByRole("button", { name: "Look up patient" }).click();
  const review = page.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(review).toBeVisible();
  await expect(
    review.getByRole("button", { name: "Assign doctor · mark seen" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("doctor can sign in and review without mutating patient status", async ({
  page,
}) => {
  await loginStaff(page, "doctor");
  await expect(page.getByRole("heading", { name: "Doctor" })).toBeVisible();

  await page.getByLabel("Reg no / QR link").fill(env("E2E_PATIENT_REG_NO"));
  await page.getByRole("button", { name: "Look up patient" }).click();
  const review = page.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(review).toBeVisible();
  await expect(
    review.getByRole("button", { name: "Confirm patient · mark seen" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("patient can sign in with registration number and passcode and sign out", async ({
  page,
}) => {
  await gotoHydrated(page, "/patient/login");
  await page.getByLabel("Registration number").fill(env("E2E_PATIENT_REG_NO"));
  await page.getByLabel("Passcode").fill(env("E2E_PATIENT_PASSWORD"));
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/patient$/);
  await expect(page.getByRole("heading", { name: "My profile" })).toBeVisible();
  await expect(
    page.getByText(env("E2E_PATIENT_NAME"), { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`#${env("E2E_PATIENT_REG_NO")}`, { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("patient phone OTP uses the real configured SMS provider", async ({
  page,
}) => {
  test.skip(
    !process.env.E2E_REAL_SMS_PHONE || !process.env.E2E_REAL_SMS_OTP,
    "Real SMS provider credentials were not supplied; OTP is not mocked.",
  );

  await gotoHydrated(page, "/patient/login");
  await page.getByRole("radio", { name: "Phone OTP" }).click();
  await page.getByLabel("Mobile number").fill(env("E2E_REAL_SMS_PHONE"));
  await page.getByRole("button", { name: "Send OTP" }).click();
  await page.getByLabel("OTP").fill(env("E2E_REAL_SMS_OTP"));
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await expect(page).toHaveURL(/\/patient$/);
});

test("staff-scan QR never logs a public visitor in", async ({ page }) => {
  const patientId = env("E2E_PATIENT_ID");

  await page.goto(`/p/${patientId}`);
  await expect(page).toHaveURL(/\/patient\/qr-help/);
  await expect(
    page.getByRole("heading", { name: "Show this at the desk" }),
  ).toBeVisible();
  await expect(page.getByText(/does not log you in/i)).toBeVisible();

  await page.goto(`/patient/enter/${patientId}`);
  await expect(page).toHaveURL(/\/patient\/qr-help/);
  await expect(
    page.getByRole("heading", { name: "Show this at the desk" }),
  ).toBeVisible();
});

test("invalid QR path shows clear help", async ({ page }) => {
  await page.goto("/p/not-a-uuid");
  await expect(page).toHaveURL(/\/patient\/qr-help\?invalid=1/);
  await expect(
    page.getByText(/incomplete or invalid/i),
  ).toBeVisible();
});

test("staff deep-link scan opens lookup-first desk", async ({ page }) => {
  const patientId = env("E2E_PATIENT_ID");
  await loginStaff(page, "volunteer");

  await page.goto(`/p/${patientId}`);
  await expect(page).toHaveURL(
    new RegExp(
      `^https?://(127\\.0\\.0\\.1|localhost)(:\\d+)?/volunteer\\?scan=${patientId}$`,
    ),
  );

  const review = page.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(review).toBeVisible({ timeout: 15_000 });
  // Lookup only — no doctor chosen yet, so assign stays disabled
  await expect(
    review.getByRole("button", { name: "Assign doctor · mark seen" }),
  ).toBeDisabled();
});

test("garbage reg/QR text fails closed without crashing desk", async ({
  page,
}) => {
  await loginStaff(page, "doctor");
  await page
    .getByLabel("Reg no / QR link")
    .fill("not-a-patient!!!!!" + "x".repeat(200));
  await page.getByRole("button", { name: "Look up patient" }).click();
  // Desk stays usable; review panel for the e2e patient must not appear
  await expect(
    page.getByRole("region", {
      name: `#${env("E2E_PATIENT_REG_NO")} · ${env("E2E_PATIENT_NAME")}`,
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Doctor" })).toBeVisible();
});
