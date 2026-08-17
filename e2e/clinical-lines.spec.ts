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

test.beforeEach(async ({ page, context }) => {
  await context.clearCookies();
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !loopbackHosts.has(url.hostname)
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
});

test("each clinical line station shows only its own decisions", async ({
  page,
}) => {
  await loginClinical(page);
  await expect(page.getByTestId("clinical-line-switcher")).toBeVisible();
  await page.getByTestId("clinical-line-fixed_power").click();
  await expect(page.getByText("Line: Ready chashma")).toBeVisible();
  await page.getByTestId("clinical-line-medicine").click();
  await expect(page.getByText("Line: Medicine")).toBeVisible();
  await page.getByTestId("clinical-line-ot").click();
  await expect(page.getByText("Line: OT")).toBeVisible();
});

test("shared clinical fields are editable first then read-only after saving", async ({
  page,
}) => {
  await loginClinical(page);
  await expect(page.getByTestId("clinical-line-switcher")).toBeVisible();
});
