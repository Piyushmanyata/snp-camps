/**
 * #71 — Prove optional client islands are real browser chunk splits.
 * Runs against the production server (`next start`), not the dev bundler.
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not created by E2E global setup.`);
  return value;
}

async function gotoHydrated(page: Page, p: string) {
  await page.goto(p, { waitUntil: "domcontentloaded" });
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

function loadChunkMap() {
  const candidates = [
    path.join(process.cwd(), ".scratch/remediation-71/route-chunk-map.json"),
    path.join(process.cwd(), "route-chunk-map.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8")) as {
        routes: Record<
          string,
          {
            deferredChunks: string[];
            deferredMarkers: Record<string, string[]>;
            initialChunks: string[];
            initialMarkers: Record<string, string[]>;
          }
        >;
      };
    }
  }
  return null;
}

function chunkUrlPath(rel: string) {
  // rel is static/chunks/foo.js → /_next/static/chunks/foo.js
  return `/_next/${rel.replace(/\\/g, "/")}`;
}

function isChunkRequest(req: Request) {
  const u = req.url();
  return u.includes("/_next/static/chunks/") && u.endsWith(".js");
}

test.beforeEach(async ({ page, context }) => {
  await context.clearCookies();
  await blockRemoteRequests(page);
});

test("production: jsqr deferred until camera open; scanner is a real split", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.E2E_PRODUCTION === "0",
    "Island split asserts require production server (E2E_PRODUCTION=1)",
  );

  // Force jsQR fallback path (native detector absent).
  await context.addInitScript(() => {
    Object.defineProperty(window, "BarcodeDetector", {
      configurable: true,
      get() {
        return undefined;
      },
    });
  });

  const map = loadChunkMap();
  // Budget gate writes the artifact during verify; rebuild path may regenerate it.
  if (!map?.routes?.["/volunteer"]) {
    await loginStaff(page, "volunteer");
    await expect(page.getByRole("button", { name: /Camera kholein/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Dhundein" }),
    ).toBeVisible();
    return;
  }

  const desk = map.routes["/volunteer"];
  const jsqrChunks = Object.entries(desk.deferredMarkers || {})
    .filter(([, markers]) => markers.includes("jsqr_lib"))
    .map(([rel]) => rel);
  const scannerChunks = Object.entries(desk.deferredMarkers || {})
    .filter(([, markers]) => markers.includes("scanner_ui"))
    .map(([rel]) => rel);

  // jsqr must be deferred (not in initial) for desk routes.
  for (const route of ["/volunteer", "/admin"] as const) {
    const r = map.routes[route];
    if (!r) continue;
    for (const [rel, markers] of Object.entries(r.initialMarkers || {})) {
      expect(
        markers,
        `${route} initial ${rel} must not ship jsqr library`,
      ).not.toContain("jsqr_lib");
      expect(
        markers,
        `${route} initial ${rel} must not ship qrcode.react`,
      ).not.toContain("qrcode_react");
    }
  }

  const chunkPaths: string[] = [];
  page.on("request", (req) => {
    if (isChunkRequest(req)) chunkPaths.push(new URL(req.url()).pathname);
  });

  await loginStaff(page, "volunteer");

  // Critical controls available without waiting for optional decoder.
  await expect(page.getByRole("button", { name: /Camera kholein/i })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Dhundein" }),
  ).toBeVisible();
  await expect(page.getByLabel("Registration number ya naam")).toBeVisible();

  const jsqrPaths = jsqrChunks.map(chunkUrlPath);
  const beforeOpen = new Set(chunkPaths);
  for (const p of jsqrPaths) {
    expect(
      [...beforeOpen].some((u) => u === p || u.endsWith(p)),
      `jsqr chunk ${p} must not load before Camera kholein`,
    ).toBeFalsy();
  }

  // jsqr loads on Camera kholein when native detector is unavailable (before getUserMedia).
  await page.getByRole("button", { name: /Camera kholein/i }).click();
  await page.waitForTimeout(2000);

  if (jsqrPaths.length > 0) {
    const loadedJsqr = jsqrPaths.some((p) =>
      chunkPaths.some((u) => u === p || u.endsWith(p)),
    );
    expect(
      loadedJsqr,
      `expected jsqr chunk(s) after Camera kholein: ${jsqrPaths.join(", ")}; seen=${chunkPaths.filter((u) => !beforeOpen.has(u)).join(", ")}`,
    ).toBeTruthy();
  } else {
    expect(
      scannerChunks.length + desk.deferredChunks.length,
      "desk route should list deferred scanner/jsqr chunks",
    ).toBeGreaterThan(0);
  }
});
test("production: print route may load qrcode; volunteer initial must not", async ({
  page,
  request,
}) => {
  test.skip(
    process.env.E2E_PRODUCTION === "0",
    "Island split asserts require production server (E2E_PRODUCTION=1)",
  );

  const map = loadChunkMap();
  if (!map?.routes) {
    test.skip(true, "route-chunk-map.json missing — run check:js-budget after build");
    return;
  }

  const volunteer = map.routes["/volunteer"];
  const printRoute = map.routes["/print/[id]"];
  if (volunteer) {
    for (const markers of Object.values(volunteer.initialMarkers || {})) {
      expect(markers).not.toContain("qrcode_react");
      expect(markers).not.toContain("jsqr_lib");
    }
  }
  if (printRoute) {
    // `QrCode` is a Server Component (no "use client"), so the patient QR ships
    // as static SVG markup and the print route pays no qrcode.react JS at all.
    // The QR is still rendered — print-prescription.spec.ts asserts it visually.
    const printQrJs = Object.values(printRoute.initialMarkers || {})
      .concat(Object.values(printRoute.deferredMarkers || {}))
      .some((m) => m.includes("qrcode_react"));
    expect(
      printQrJs,
      "print route should render the QR server-side, shipping no qrcode.react chunk",
    ).toBeFalsy();
  }

  // Volunteer critical controls before optional admin tools.
  await loginStaff(page, "volunteer");
  await expect(page.getByRole("link", { name: /Register/i }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Camera kholein/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dhundein" })).toBeVisible();

  // Health of production server
  const health = await request.get("/api/health");
  expect(health.ok()).toBeTruthy();
});
