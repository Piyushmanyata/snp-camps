/**
 * Decode-surface geometry for the live Aadhaar scanner.
 *
 * Split out from qr-decode-pipeline so the main thread can size a probe crop
 * without pulling in the preprocessing cascade (grayscale, Otsu, adaptive
 * threshold) that only ever runs inside the decode worker. That cascade is a
 * few KB the registration routes must not pay for at load: /register sits
 * within a few hundred bytes of its JS budget (#71).
 *
 * Pure arithmetic, no imports, no DOM.
 */

/**
 * Longest edge, in pixels, worth handing a decoder.
 *
 * Decode cost is linear in pixel count, so bounding the surface is the single
 * biggest win available (measured at 2560x1440 vs 1280x720: 180ms vs 39ms for
 * one cheap pass, 1222ms vs 288ms for the full cascade).
 *
 * 1200 is measured, not guessed. Against a synthetic 2560x1440 frame holding a
 * faint tiny legacy QR, tightening 1600 -> 1200 *raised* the hit rate (4/8 ->
 * 5/8 probe-variant combinations) while halving cost (1082 -> 549ms): shrinking
 * averages sensor noise away instead of aliasing it into the modules. The floor
 * is set by the densest modern Secure QR, which still reads at 1200 but fails
 * outright at 800 — so do not lower this without re-running that check
 * (tests/qr-decode-surface.test.mjs).
 *
 * Capture stays high-resolution; only the decode surface is bounded.
 */
export const MAX_DECODE_EDGE = 1200;

/** Scale factor that brings `width`x`height` under `MAX_DECODE_EDGE`. */
export function decodeScale(
  width: number,
  height: number,
  cap = MAX_DECODE_EDGE,
): number {
  return Math.min(1, cap / Math.max(width, height));
}

/** One probe geometry: a centre-ish crop of the frame, magnified by `zoom`. */
export type Probe = {
  scale: number;
  zoom: number;
  offsetX?: number;
  offsetY?: number;
};

/**
 * Source rect and bounded destination size for one probe against a frame.
 *
 * Pure and exported so the destination bound is testable: twice now a refactor
 * of the live loop dropped the cap and decoded crops at native camera
 * resolution, which costs seconds per frame and reads as a frozen scanner.
 * Returns null when the crop is too small to hold a QR.
 */
export function probeSurface(
  frameWidth: number,
  frameHeight: number,
  probe: Probe,
): { sx: number; sy: number; cw: number; ch: number; dw: number; dh: number } | null {
  const cw = Math.floor(frameWidth * probe.scale);
  const ch = Math.floor(frameHeight * probe.scale);
  if (cw < 100 || ch < 100) return null;

  const sx = Math.max(
    0,
    Math.min(
      frameWidth - cw,
      Math.floor((frameWidth - cw) / 2 + (probe.offsetX || 0) * frameWidth),
    ),
  );
  const sy = Math.max(
    0,
    Math.min(
      frameHeight - ch,
      Math.floor((frameHeight - ch) / 2 + (probe.offsetY || 0) * frameHeight),
    ),
  );

  // Zoom raises pixels-per-module for the physically tiny legacy QR; the cap
  // then bounds the cost, so the zoom intent survives without the pixel bill.
  const shrink = decodeScale(cw * probe.zoom, ch * probe.zoom);
  return {
    sx,
    sy,
    cw,
    ch,
    dw: Math.max(1, Math.floor(cw * probe.zoom * shrink)),
    dh: Math.max(1, Math.floor(ch * probe.zoom * shrink)),
  };
}
