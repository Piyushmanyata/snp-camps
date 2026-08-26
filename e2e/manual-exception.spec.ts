import { expect, test, type Page } from "@playwright/test";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E global setup.`);
  return value;
}

async function gotoHydrated(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

async function loginVolunteer(page: Page) {
  await gotoHydrated(page, "/login");
  await page.locator("form").getByLabel("Email").fill(env("E2E_VOLUNTEER_EMAIL"));
  await page
    .locator("form")
    .getByLabel("Password")
    .fill(env("E2E_VOLUNTEER_PASSWORD"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/volunteer$/);
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

test("volunteer reaches manual entry after two failed scans", async ({
  page,
}) => {
  await loginVolunteer(page);
  await gotoHydrated(page, "/register");

  const phone = page.getByLabel(/Ghar ka mobile number/i);
  await expect(async () => {
    await phone.fill("9876543210");
    await expect(phone).toHaveValue("9876543210");
  }).toPass({ timeout: 5_000 });

  await page.getByTestId("aadhaar-consent").check();
  const usb = page.getByLabel("USB Aadhaar scanner input");
  await expect(usb).toBeEditable();
  await expect(usb).toBeFocused();

  await page.keyboard.insertText("not-an-aadhaar-qr");
  await page.keyboard.press("Enter");
  await expect(usb).toBeEditable();
  await expect(usb).toBeFocused();
  await page.keyboard.insertText("still-not-an-aadhaar-qr");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("desk-manual-entry-escape")).toBeVisible({
    timeout: 15_000,
  });
});
