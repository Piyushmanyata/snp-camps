"use client";

import { QRCodeSVG } from "qrcode.react";

/** Tiny client island for QR rendering (keeps parent pages as server components). */
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
