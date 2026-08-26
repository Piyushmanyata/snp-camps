import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(
  join(root, "src/components/aadhaar-usb-input.tsx"),
  "utf8",
);

test("AadhaarUsbInput has retired the manual Padhein button in favor of auto-scan", () => {
  assert.doesNotMatch(src, />\s*Padhein\s*</);
  assert.doesNotMatch(src, /<Button/);
});

test("AadhaarUsbInput includes an accessible loading status indicator", () => {
  assert.match(src, /role="status"/);
  assert.match(src, /aria-live="polite"/);
  assert.match(src, /Spinner/);
  assert.match(src, /padh rahe hain…/i);
});

test("AadhaarUsbInput visually masks typed characters so raw numbers do not appear", () => {
  assert.match(src, /text-transparent/);
  assert.match(src, /caret-transparent/);
});

test("AadhaarUsbInput automatically triggers read on input debounce and Enter key", () => {
  assert.match(src, /onInput=\{scheduleRead\}/);
  assert.match(src, /event\.key !== "Enter"/);
  assert.match(src, /scanner\.readPayload/);
  assert.match(src, /inputRef\.current\.value = ""/);
});

test("AadhaarUsbInput meets minimum field touch target standards", () => {
  assert.match(src, /min-h-12/);
});
