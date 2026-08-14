
export const MAX_DECODE_EDGE = 1200;

export function decodeScale(
  width: number,
  height: number,
  cap = MAX_DECODE_EDGE,
): number {
  return Math.min(1, cap / Math.max(width, height));
}

export type Probe = {
  scale: number;
  zoom: number;
  offsetX?: number;
  offsetY?: number;
};

export const AADHAAR_PROBES: Probe[] = [
  { scale: 1, zoom: 1 },
  { scale: 0.6, zoom: 1 },
  { scale: 0.4, zoom: 2 },
  { scale: 0.25, zoom: 2 },
  { scale: 0.4, zoom: 2, offsetX: -0.15, offsetY: -0.15 },
  { scale: 0.4, zoom: 2, offsetX: 0.15, offsetY: -0.15 },
  { scale: 0.4, zoom: 2, offsetX: -0.15, offsetY: 0.15 },
  { scale: 0.4, zoom: 2, offsetX: 0.15, offsetY: 0.15 },
];

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
