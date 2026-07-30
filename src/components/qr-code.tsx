import { QRCodeSVG } from "qrcode.react";

/** Pure SVG QR renderer; it needs no hydration when used by a Server Component. */
export function QrCode({
  value,
  size = 200,
  level = "M",
  includeMargin = false,
  fgColor = "#0a5c3a",
  bgColor = "#ffffff",
}: {
  value: string;
  size?: number;
  level?: "L" | "M" | "Q" | "H";
  includeMargin?: boolean;
  fgColor?: string;
  bgColor?: string;
}) {
  return (
    <QRCodeSVG
      value={value}
      size={size}
      level={level}
      includeMargin={includeMargin}
      bgColor={bgColor}
      fgColor={fgColor}
    />
  );
}
