import { expect, test, type ConsoleMessage } from "@playwright/test";

/**
 * Live CSP served by middleware/proxy (#13 leftover + #39 relocation).
 * Asserts the response header, not next.config source greps.
 */
test("served Content-Security-Policy has nonce, no script unsafe-inline, hydrates cleanly", async ({
  page,
}) => {
  const cspViolations: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    const text = msg.text();
    if (
      msg.type() === "error" &&
      (/content security policy/i.test(text) ||
        /csp/i.test(text) ||
        /refused to execute/i.test(text) ||
        /refused to load/i.test(text))
    ) {
      cspViolations.push(text);
    }
  });

  const response = await page.goto("/");
  expect(response, "home page response").toBeTruthy();
  expect(response!.ok()).toBeTruthy();

  const csp = response!.headers()["content-security-policy"];
  expect(csp, "Content-Security-Policy header present").toBeTruthy();

  expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
  // script-src must not allow arbitrary inline scripts.
  const scriptSrc = csp!
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"));
  expect(scriptSrc).toBeTruthy();
  expect(scriptSrc).not.toMatch(/'unsafe-inline'/);

  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("heading", { name: "Medical Camp Desk" }),
  ).toBeVisible();

  expect(cspViolations, `CSP console errors: ${cspViolations.join(" | ")}`).toEqual(
    [],
  );
});
