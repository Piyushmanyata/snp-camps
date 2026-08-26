import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E global setup.`);
  return value;
}

function kolkataTodayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function gotoHydrated(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

async function loginStaff(
  page: Page,
  role: "admin" | "volunteer" | "team_lead",
) {
  await gotoHydrated(page, "/login");
  await page.locator("form").getByLabel("Email").fill(env(`E2E_${role.toUpperCase()}_EMAIL`));
  await page
    .locator("form")
    .getByLabel("Password")
    .fill(env(`E2E_${role.toUpperCase()}_PASSWORD`));
  await page.getByRole("button", { name: "Sign in" }).click();
  const landing = role === "team_lead" ? "volunteer" : role;
  await expect(page).toHaveURL(new RegExp(`/${landing}$`));
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

function livePayload(printingOpen: boolean) {
  return {
    days: [
      {
        id: env("E2E_CAMP_DAY_ID"),
        camp_id: env("E2E_CAMP_ID"),
        day_date: kolkataTodayIso(),
        seat_limit: 100,
        seats_taken: 0,
        seats_left: 100,
        is_full: false,
        printing_open: printingOpen,
      },
    ],
  };
}

async function setPrintingOpen(printingOpen: boolean) {
  const admin = createClient(
    env("E2E_SUPABASE_URL"),
    env("E2E_SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const updated = await admin
    .from("camp_days")
    .update({ printing_open: printingOpen })
    .eq("id", env("E2E_CAMP_DAY_ID"));
  if (updated.error) {
    throw new Error(`printing_open update failed: ${updated.error.message}`);
  }
}

async function mockDeskLive(page: Page, printingOpen: boolean) {
  await page.route("**/api/desk/live**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(livePayload(printingOpen)),
    });
  });
}

test.beforeEach(async ({ page, context }) => {
  await context.clearCookies();
  await blockRemoteRequests(page);
});

test("volunteer sees Register only while the window is closed", async ({
  page,
}) => {
  await mockDeskLive(page, false);
  await loginStaff(page, "volunteer");
  await expect(page.getByTestId("desk-print-window-closed")).toBeVisible();
  await expect(page.getByTestId("desk-print-window-open")).toHaveCount(0);
  await expect(page.getByTestId("print-prescription")).toHaveCount(0);
  await expect(page.getByTestId("mark-seen")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Register new patient" }),
  ).toBeVisible();
});

test("volunteer sees Register plus Print plus Mark seen when open", async ({
  page,
}) => {
  await mockDeskLive(page, true);
  await loginStaff(page, "volunteer");
  await expect(page.getByTestId("desk-print-window-open")).toBeVisible();
  await page
    .getByLabel("Registration number or name")
    .fill(env("E2E_PATIENT_REG_NO"));
  await page.getByRole("button", { name: "Search" }).click();
  const review = page.getByRole("region", {
    name: `#${env("E2E_PATIENT_REG_NO")} ${env("E2E_PATIENT_NAME")}`,
  });
  await expect(review).toBeVisible();
  await expect(review.getByTestId("print-prescription")).toBeVisible();
});

test("a team lead sees the same print window as a volunteer", async ({
  page,
}) => {
  await mockDeskLive(page, false);
  await loginStaff(page, "team_lead");
  await expect(page.getByTestId("desk-print-window-closed")).toBeVisible();
  await expect(page.getByTestId("print-prescription")).toHaveCount(0);
});

test("the print URL renders a refusal card while the window is closed", async ({
  page,
}) => {
  await loginStaff(page, "volunteer");
  await setPrintingOpen(false);
  try {
    await gotoHydrated(page, `/print/${env("E2E_PATIENT_ID")}`);
    await expect(page.getByText("Printing is closed")).toBeVisible();
    await expect(
      page.getByText("Ask admin to open print window"),
    ).toBeVisible();
    await expect(page.getByTestId("prescription-sheet")).toHaveCount(0);
  } finally {
    await setPrintingOpen(true);
  }
});
