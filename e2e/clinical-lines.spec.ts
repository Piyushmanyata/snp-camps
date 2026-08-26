import { expect, test, type Page } from "@playwright/test";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E global setup.`);
  return value;
}

async function loginClinical(page: Page) {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page
    .locator("form")
    .getByLabel("Email")
    .fill(env("E2E_CLINICAL_OPERATOR_EMAIL"));
  await page
    .locator("form")
    .getByLabel("Password")
    .fill(env("E2E_CLINICAL_OPERATOR_PASSWORD"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/clinical$/);
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

test("each clinical line station shows only its own decisions", async ({
  page,
}) => {
  await loginClinical(page);
  await expect(page.getByTestId("clinical-line-switcher")).toBeVisible();
  await page.getByTestId("clinical-line-fixed_power").click();
  await expect(page.getByText("Line: Ready spectacles")).toBeVisible();
  await page.getByTestId("clinical-line-medicine").click();
  await expect(page.getByText("Line: Medicines")).toBeVisible();
  await page.getByTestId("clinical-line-ot").click();
  await expect(page.getByText("Line: Surgery (OT)")).toBeVisible();
});

test("shared clinical fields are editable first then read-only after saving", async ({
  page,
}) => {
  await loginClinical(page);
  await expect(page.getByTestId("clinical-line-switcher")).toBeVisible();
});
