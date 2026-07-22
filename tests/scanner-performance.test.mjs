import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const scanner = fs.readFileSync(
  path.join(process.cwd(), "src/components/qr-scanner.tsx"),
  "utf8",
);

function readNumber(name) {
  const match = scanner.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(match, `${name} must be a numeric scanner constant`);
  return Number(match[1]);
}

test("scanner caps camera and decode work for responsive mobile use", () => {
  const fps = readNumber("SCANNER_FPS");
  const width = readNumber("SCANNER_VIDEO_WIDTH");
  const height = readNumber("SCANNER_VIDEO_HEIGHT");

  assert.ok(fps >= 10 && fps <= 12, `decode rate must stay at 10-12fps, got ${fps}`);
  assert.equal(width, 1280);
  assert.equal(height, 720);
  assert.match(
    scanner,
    /const SCANNER_FRAME_INTERVAL_MS = 1000 \/ SCANNER_FPS;/,
  );
  assert.match(
    scanner,
    /now - lastFrameTime >= SCANNER_FRAME_INTERVAL_MS/,
    "native detection must use the capped cadence",
  );
  assert.match(scanner, /fps: SCANNER_FPS/, "fallback detection must use the same cap");
  assert.equal(
    scanner.match(/width: \{ ideal: SCANNER_VIDEO_WIDTH \}/g)?.length,
    2,
    "native and fallback cameras must both request the capped width",
  );
  assert.equal(
    scanner.match(/height: \{ ideal: SCANNER_VIDEO_HEIGHT \}/g)?.length,
    2,
    "native and fallback cameras must both request the capped height",
  );
  assert.match(scanner, /scaleTick % 2 === 0/);
  assert.equal(scanner.match(/await tryDecode\(/g)?.length, 3);

  const oldPassesPerSecond = 30 + 30 / 2 + 30 / 2;
  const newPassesPerSecond = fps + fps / 2 + fps / 2;
  assert.ok(newPassesPerSecond <= oldPassesPerSecond / 3);
  assert.ok(width * height <= 1280 * 720);
});

test("scanner reuses canvases and retains serial decode teardown guards", () => {
  assert.match(
    scanner,
    /if \(canvas\.width === width && canvas\.height === height\) return;/,
    "unchanged canvas dimensions must not reset the backing store",
  );
  assert.equal(
    scanner.match(/ensureCanvasSize\(/g)?.length,
    3,
    "one helper definition and both scale buffers must use canvas reuse",
  );
  assert.doesNotMatch(scanner, /setInterval\(/, "decode work must not overlap on an interval");
  assert.equal(
    scanner.match(/requestAnimationFrame\(processFrame\)/g)?.length,
    2,
    "native decode must have one initial schedule and one serial self-schedule",
  );
  assert.match(scanner, /if \(starting \|\| active/);
  assert.match(scanner, /cancelAnimationFrame\(animFrameRef\.current\)/);
  assert.match(scanner, /generation !== scannerGeneration\.current/);
});
