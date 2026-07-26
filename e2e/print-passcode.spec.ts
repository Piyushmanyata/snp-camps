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

test("desk slip has no passcode; A4 is one distinct slip + empty cells; thermal one-up", async ({
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

  // Default: A4 multi-up — ONE distinct patient, three empty cells (#64).
  await expect(page.getByTestId("desk-slip-a4")).toBeVisible();
  await expect(page.getByTestId("desk-slip-a4")).toHaveAttribute(
    "data-slip-count",
    "1",
  );
  await expect(page.getByTestId("desk-slip-a4-cell")).toHaveCount(1);
  await expect(page.getByTestId("desk-slip-a4-cell-empty")).toHaveCount(3);
  await expect(page.getByTestId("desk-slip-reg-no")).toHaveCount(1);
  await expect(page.getByTestId("desk-slip-name").first()).toBeVisible();
  await expect(page.getByTestId("desk-slip-camp-day").first()).toBeVisible();
  await expect(page.getByTestId("desk-slip-venue").first()).toBeVisible();

  fs.mkdirSync(samplesDir, { recursive: true });
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

test("print media geometry: A4 page, QR inside bounds, no overflow clip", async ({
  page,
}) => {
  const patientId = env("E2E_PATIENT_ID");
  await loginStaff(page, "volunteer");
  await gotoHydrated(page, `/print/${patientId}`);

  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("desk-slip-a4")).toBeVisible();

  const geometry = await page.evaluate(() => {
    const sheet = document.querySelector(
      '[data-testid="desk-slip-a4"]',
    ) as HTMLElement | null;
    const qr = document.querySelector(
      '[data-testid="desk-slip-qr"]',
    ) as HTMLElement | null;
    const name = document.querySelector(
      '[data-testid="desk-slip-name"]',
    ) as HTMLElement | null;
    const reg = document.querySelector(
      '[data-testid="desk-slip-reg-no"]',
    ) as HTMLElement | null;
    if (!sheet || !qr || !name || !reg) {
      return { ok: false as const, reason: "missing nodes" };
    }
    const sheetBox = sheet.getBoundingClientRect();
    const qrBox = qr.getBoundingClientRect();
    const nameBox = name.getBoundingClientRect();
    const style = getComputedStyle(sheet);
    const overflow = style.overflow;
    // QR fully inside sheet
    const qrInside =
      qrBox.left >= sheetBox.left - 1 &&
      qrBox.top >= sheetBox.top - 1 &&
      qrBox.right <= sheetBox.right + 1 &&
      qrBox.bottom <= sheetBox.bottom + 1;
    const nameInside =
      nameBox.left >= sheetBox.left - 1 &&
      nameBox.right <= sheetBox.right + 1;
    // Reg number should be the largest text element
    const regFont = parseFloat(getComputedStyle(reg).fontSize);
    const nameFont = parseFloat(getComputedStyle(name).fontSize);
    return {
      ok: true as const,
      qrInside,
      nameInside,
      overflow,
      regFont,
      nameFont,
      sheetWidth: sheetBox.width,
      sheetHeight: sheetBox.height,
      emptyCount: document.querySelectorAll(
        '[data-testid="desk-slip-a4-cell-empty"]',
      ).length,
      filledCount: document.querySelectorAll(
        '[data-testid="desk-slip-a4-cell"]',
      ).length,
    };
  });

  expect(geometry.ok).toBe(true);
  if (!geometry.ok) return;
  expect(geometry.qrInside).toBe(true);
  expect(geometry.nameInside).toBe(true);
  expect(geometry.overflow === "hidden").toBe(false);
  expect(geometry.regFont).toBeGreaterThan(geometry.nameFont);
  expect(geometry.filledCount).toBe(1);
  expect(geometry.emptyCount).toBe(3);
  // A4 preview ~210mm wide at 96dpi ≈ 794px; allow layout variance
  expect(geometry.sheetWidth).toBeGreaterThan(500);

  fs.mkdirSync(scratchDir, { recursive: true });
  const pdfPath = path.join(scratchDir, "a4-single-print-media.pdf");
  const pdf = await page.pdf({
    path: pdfPath,
    format: "A4",
    printBackground: true,
    margin: { top: "4mm", right: "4mm", bottom: "4mm", left: "4mm" },
  });
  expect(pdf.byteLength).toBeGreaterThan(1000);
});

test("thermal print media: 58mm-class width, content not overflow-hidden", async ({
  page,
}) => {
  const patientId = env("E2E_PATIENT_ID");
  await loginStaff(page, "volunteer");
  await gotoHydrated(page, `/print/${patientId}`);
  await page.getByRole("button", { name: "58mm thermal" }).click();
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
    // Tall enough for max content — not a hard 110mm clip
    height: "200mm",
    printBackground: true,
    margin: { top: "2mm", right: "2mm", bottom: "2mm", left: "2mm" },
  });
});
