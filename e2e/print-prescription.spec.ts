import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const scratchDir = path.join(process.cwd(), ".scratch", "print-prescription");

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E global setup.`);
  return value;
}

async function gotoHydrated(page: Page, pathName: string) {
  await page.goto(pathName, { waitUntil: "domcontentloaded" });
}

async function loginStaff(page: Page, role: "admin" | "volunteer") {
  await gotoHydrated(page, "/login");
  await page.locator("form").getByLabel("Email").fill(env(`E2E_${role.toUpperCase()}_EMAIL`));
  await page
    .locator("form")
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

test("prescription sheet prints identity only, with no passcode and no clinical data", async ({
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

  const sheet = page.getByTestId("prescription-sheet");
  await expect(sheet).toBeVisible();

  // Passcode auth is retired (ADR 0001) — paper must carry no login secret.
  await expect(page.getByText(/passcode/i)).toHaveCount(0);

  // Identity block is pre-filled (D19).
  await expect(sheet.getByText(env("E2E_PATIENT_NAME"))).toBeVisible();
  await expect(
    sheet.getByText(new RegExp(env("E2E_PATIENT_REG_NO"))).first(),
  ).toBeVisible();

  // Deliberately absent: e-mail was dropped from the form (D19), and the app
  // holds no clinical data to print (ADR 0008) — those fields stay handwritten.
  await expect(sheet.getByText(/e-?mail/i)).toHaveCount(0);

  const hydration = consoleErrors.filter((t) => /hydrat/i.test(t));
  expect(hydration, `unexpected console: ${consoleErrors.join(" | ")}`).toEqual(
    [],
  );
});

test("maximum bounded template is one A4 page, with QR inside", async ({
  page,
}) => {
  const patientId = env("E2E_PATIENT_ID");
  await loginStaff(page, "volunteer");
  await gotoHydrated(page, `/print/${patientId}`);
  await expect(page.getByTestId("prescription-sheet")).toBeVisible();

  // Measured on SCREEN: the preview is capped at A4 width. Under print media
  // the sheet is intentionally width:100% because `@page` sizes the paper, so
  // measuring it there would prove nothing about the printed output.
  const geometry = await page.evaluate(() => {
    const sheet = document.querySelector(
      '[data-testid="prescription-sheet"]',
    ) as HTMLElement | null;
    if (!sheet) return { ok: false as const };
    const sheetBox = sheet.getBoundingClientRect();
    const style = getComputedStyle(sheet);
    const qr = sheet.querySelector("svg, img[src^='data:']") as HTMLElement | null;
    const qrBox = qr?.getBoundingClientRect() ?? null;
    return {
      ok: true as const,
      widthMm: sheetBox.width / 3.78, // rough CSS px→mm at 96dpi
      overflowHidden: style.overflow === "hidden",
      hasQr: Boolean(qrBox),
      // The QR sits top-right beside the Reg. No. box (D17).
      qrTopRight: qrBox
        ? qrBox.right <= sheetBox.right + 2 &&
          qrBox.left > sheetBox.left + sheetBox.width / 2 &&
          qrBox.top < sheetBox.top + sheetBox.height / 3
        : false,
      qrInside: qrBox
        ? qrBox.left >= sheetBox.left - 2 &&
          qrBox.right <= sheetBox.right + 2 &&
          qrBox.top >= sheetBox.top - 2 &&
          qrBox.bottom <= sheetBox.bottom + 2
        : false,
    };
  });

  expect(geometry.ok).toBe(true);
  if (!geometry.ok) return;
  // A4 is 210mm; allow slack for the preview container's own padding.
  expect(geometry.widthMm).toBeGreaterThan(120);
  expect(geometry.widthMm).toBeLessThan(230);
  expect(geometry.overflowHidden).toBe(false);
  expect(geometry.hasQr).toBe(true);
  expect(geometry.qrInside).toBe(true);
  expect(geometry.qrTopRight).toBe(true);

  // Under print media the sheet must stay visible and unclipped — the desk
  // chrome hides, the form does not.
  await page.emulateMedia({ media: "print" });
  const printState = await page.evaluate(() => {
    const sheet = document.querySelector(
      '[data-testid="prescription-sheet"]',
    ) as HTMLElement | null;
    if (!sheet) return { ok: false as const };
    const cs = getComputedStyle(sheet);
    const box = sheet.getBoundingClientRect();
    return {
      ok: true as const,
      visibility: cs.visibility,
      display: cs.display,
      overflow: cs.overflow,
      hasArea: box.width > 0 && box.height > 0,
    };
  });
  expect(printState.ok).toBe(true);
  if (!printState.ok) return;
  expect(printState.visibility).toBe("visible");
  expect(printState.display).not.toBe("none");
  expect(printState.overflow).not.toBe("hidden");
  expect(printState.hasArea).toBe(true);

  // Real proof of the paper geometry: render the actual A4 PDF.
  fs.mkdirSync(scratchDir, { recursive: true });
  const pdfBuffer = await page.pdf({
    path: path.join(scratchDir, "prescription-a4.pdf"),
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
  });
  const pdf = fs.statSync(path.join(scratchDir, "prescription-a4.pdf"));
  expect(pdf.size).toBeGreaterThan(1000);
  const pageObjects =
    pdfBuffer.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  expect(pageObjects, "prescription PDF must be exactly one A4 page").toBe(1);
});
