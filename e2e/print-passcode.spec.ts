import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const samplesDir = path.join(process.cwd(), "docs", "desk-slip-samples");

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E global setup.`);
  return value;
}

async function gotoHydrated(page: Page, pathName: string) {
  await page.goto(pathName);
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

test("desk slip has no passcode; A4 multi-up and thermal58 render", async ({
  page,
}) => {
  const patientId = env("E2E_PATIENT_ID");
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await loginStaff(page, "volunteer");
  await gotoHydrated(page, `/print/${patientId}`);

  // Passcode auth retired (#45 / #54) — slip must not show login secrets.
  await expect(page.getByText(/login passcode|desk-slip passcode/i)).toHaveCount(
    0,
  );
  await expect(page.getByText(/passcode/i)).toHaveCount(0);

  // Default: A4 multi-up with reg no + name + camp day + venue
  await expect(page.getByTestId("desk-slip-a4")).toBeVisible();
  await expect(page.getByTestId("desk-slip-reg-no").first()).toBeVisible();
  await expect(page.getByTestId("desk-slip-name").first()).toBeVisible();
  await expect(page.getByTestId("desk-slip-camp-day").first()).toBeVisible();
  await expect(page.getByTestId("desk-slip-venue").first()).toBeVisible();
  // 2×2 multi-up = 4 copies
  await expect(page.getByTestId("desk-slip-reg-no")).toHaveCount(4);

  await page
    .getByTestId("desk-slip-a4")
    .screenshot({ path: path.join(samplesDir, "a4-multi-up.png") });

  // Switch to 58mm thermal
  await page.getByRole("button", { name: "58mm thermal" }).click();
  await expect(page.getByTestId("desk-slip-thermal")).toBeVisible();
  await expect(page.getByTestId("desk-slip-a4")).toHaveCount(0);
  await expect(page.getByTestId("desk-slip-reg-no")).toHaveCount(1);
  await expect(page.getByText(/login passcode|desk-slip passcode/i)).toHaveCount(
    0,
  );

  await page
    .getByTestId("desk-slip-thermal")
    .screenshot({ path: path.join(samplesDir, "thermal-58mm.png") });

  // Format setting control is present (one obvious place)
  await expect(
    page.getByRole("group", { name: "Desk slip printer format" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "A4 multi-up" }).click();
  await expect(page.getByTestId("desk-slip-a4")).toBeVisible();

  const hydration = consoleErrors.filter((t) => /hydrat/i.test(t));
  expect(hydration, `unexpected console: ${consoleErrors.join(" | ")}`).toEqual(
    [],
  );
});
