import { expect, test, type Page, type Route } from "@playwright/test";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E global setup.`);
  return value;
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

test("stalled self-registration times out, keeps entered data, and reuses the request id", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await blockRemoteRequests(page);
  const requestIds: string[] = [];
  const firstRequest: { route?: Route } = {};

  await page.route("**/api/self-registration", async (route) => {
    const posted = route.request().postDataJSON() as { requestId?: string };
    requestIds.push(String(posted.requestId || ""));
    if (requestIds.length === 1) {
      firstRequest.route = route;
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: "Could not complete registration. Please ask for help at the camp desk.",
      }),
    });
  });

  await page.goto("/self-register", { waitUntil: "domcontentloaded" });
  const cachedNoDay = page.getByText(
    "No Camp Days available right now. Please try again later.",
    { exact: true },
  );
  if (await cachedNoDay.isVisible().catch(() => false)) {
    await page.waitForTimeout(6_000);
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  await page
    .getByRole("checkbox", {
      name: /I consent to extracting details from my Aadhaar card/,
    })
    .check();
  const photo = page.getByTestId("aadhaar-gallery-input");
  await photo.setInputFiles(env("E2E_FAKE_AADHAAR_PHOTO_PATH"));
  await expect(
    page.getByRole("heading", { name: "Confirm details" }),
  ).toBeVisible({ timeout: 20_000 });
  await page.clock.install();
  await page.getByLabel(/mobile|phone|number/i).fill("9876501234");
  const day = page.getByRole("radio").first();
  if ((await day.count()) > 0) {
    await day.click();
  } else {
    const select = page.locator("#camp-day");
    if (
      (await select.count()) > 0 &&
      (await select.locator("option").count()) > 1
    ) {
      await select.selectOption({ index: 1 });
    }
  }
  await page.getByRole("button", { name: "Complete registration" }).click();
  await page.clock.fastForward(20_001);
  await expect(page.getByText(/Request timed out/i)).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByLabel(/mobile|phone|number/i)).toHaveValue("9876501234");
  await page.getByRole("button", { name: "Complete registration" }).click();
  await expect(page.getByText(/ask for help at the camp desk/i)).toBeVisible({
    timeout: 10_000,
  });
  expect(requestIds.length).toBeGreaterThanOrEqual(2);
  expect(requestIds[0]).toEqual(requestIds[1]);
  expect(requestIds[0]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  await firstRequest.route
    ?.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        patientId: "11111111-1111-4111-8111-111111111111",
        registrationNumber: 9999,
        dayDate: "2099-01-01",
      }),
    })
    .catch(() => {});
  await page.clock.fastForward(1_000);
  await expect(page.getByText(/ask for help at the camp desk/i)).toBeVisible();
  await expect(page.getByText(/9999/)).toHaveCount(0);
});
