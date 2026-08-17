import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const slip = path.join(root, "src", "app", "clinical", "slip", "[id]", "page.tsx");
const font = path.join(root, "public", "fonts", "slip-devanagari.woff2");

test("58mm slip self-hosts a Devanagari subset and prints Hindi labels", () => {
  const page = fs.readFileSync(slip, "utf8");
  assert.match(page, /slip-devanagari\.woff2/);
  assert.match(page, /SlipDevanagari|slip-devanagari/);
  assert.match(page, /चश्मा/);
  assert.match(page, /ऑपरेशन/);
  assert.match(page, /नाम/);
  assert.ok(fs.existsSync(font), "public/fonts/slip-devanagari.woff2 must exist");
  assert.ok(fs.statSync(font).size > 200, "subset font must be a real woff2");
});
