import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const samplesDir = path.join(process.cwd(), "docs", "desk-slip-samples");
const scratchDir = path.join(process.cwd(), ".scratch", "remediation-64");

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

test("desk slip has no passcode; thermal 58mm one-up format", async ({
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

  // Thermal 58mm is the only format
  await expect(page.getByTestId("desk-slip-thermal")).toBeVisible();
  await expect(page.getByTestId("desk-slip-reg-no")).toHaveCount(1);
  await expect(page.getByTestId("desk-slip-name").first()).toBeVisible();
  await expect(page.getByTestId("desk-slip-camp-day").first()).toBeVisible();
  await expect(page.getByTestId("desk-slip-venue").first()).toBeVisible();

  fs.mkdirSync(samplesDir, { recursive: true });
  await page
    .getByTestId("desk-slip-thermal")
    .screenshot({ path: path.join(samplesDir, "thermal-58mm.png") });

  const hydration = consoleErrors.filter((t) => /hydrat/i.test(t));
  expect(hydration, `unexpected console: ${consoleErrors.join(" | ")}`).toEqual(
    [],
  );
});

test("thermal print media: 58mm-class width, content not overflow-hidden", async ({
  page,
}) => {
  const patientId = env("E2E_PATIENT_ID");
  await loginStaff(page, "volunteer");
  await gotoHydrated(page, `/print/${patientId}`);
  await expect(page.getByTestId("desk-slip-thermal")).toBeVisible();

  await page.emulateMedia({ media: "print" });

  const geometry = await page.evaluate(() => {
    const sheet = document.querySelector(
      '[data-testid="desk-slip-thermal"]',
    ) as HTMLElement | null;
    const qr = document.querySelector(
      '[data-testid="desk-slip-qr"]',
    ) as HTMLElement | null;
    if (!sheet || !qr) return { ok: false as const };
    const sheetBox = sheet.getBoundingClientRect();
    const qrBox = qr.getBoundingClientRect();
    const style = getComputedStyle(sheet);
    // 58mm ≈ 219px at 96dpi; print CSS uses 54mm content width
    const widthMm = sheetBox.width / 3.78; // rough CSS px→mm
    return {
      ok: true as const,
      widthPx: sheetBox.width,
      widthMm,
      heightPx: sheetBox.height,
      overflow: style.overflow,
      qrInside:
        qrBox.left >= sheetBox.left - 2 &&
        qrBox.right <= sheetBox.right + 2 &&
        qrBox.top >= sheetBox.top - 2 &&
        qrBox.bottom <= sheetBox.bottom + 2,
      regCount: document.querySelectorAll('[data-testid="desk-slip-reg-no"]')
        .length,
    };
  });

  expect(geometry.ok).toBe(true);
  if (!geometry.ok) return;
  expect(geometry.regCount).toBe(1);
  expect(geometry.widthMm).toBeLessThan(70);
  expect(geometry.widthMm).toBeGreaterThan(40);
  expect(geometry.overflow === "hidden").toBe(false);
  expect(geometry.qrInside).toBe(true);

  fs.mkdirSync(scratchDir, { recursive: true });
  await page.pdf({
    path: path.join(scratchDir, "thermal-print-media.pdf"),
    width: "58mm",
    height: "200mm",
    printBackground: true,
    margin: { top: "2mm", right: "2mm", bottom: "2mm", left: "2mm" },
  });
});
