/**
 * Copy decoder WASM binaries into public/wasm so they are served same-origin.
 *
 * Both zxing-wasm and zbar-wasm resolve their .wasm from a CDN by default. A
 * camp desk runs on a phone hotspot and is frequently offline, so a CDN fetch
 * is exactly the request that hangs — and a scanner that cannot load its
 * decoder is a scanner that never reads a card. Serving them from our own
 * origin also lets the service worker precache them.
 *
 * Run from `prebuild` and `postinstall`; safe to re-run.
 */
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const outDir = join(process.cwd(), "public", "wasm");

// Resolved through Node, not guessed paths, so a package layout change fails
// this script loudly at build time instead of silently shipping a stale binary.
// zxing-wasm and zbar-wasm both export their .wasm as a subpath; opencv-js has
// no "exports" field, so its package.json is resolvable directly.
const assets = [
  {
    from: require.resolve("zxing-wasm/reader/zxing_reader.wasm"),
    to: "zxing_reader.wasm",
  },
  {
    from: require.resolve("@undecaf/zbar-wasm/dist/zbar.wasm"),
    to: "zbar.wasm",
  },
  {
    from: join(
      dirname(require.resolve("@techstark/opencv-js/package.json")),
      "dist/opencv.js",
    ),
    to: "opencv.js",
  },
];

mkdirSync(outDir, { recursive: true });

for (const asset of assets) {
  const target = join(outDir, asset.to);
  copyFileSync(asset.from, target);
  const kb = Math.round(statSync(target).size / 1024);
  console.log(`wasm: ${asset.to} (${kb} KB)`);
}
