"use client";

import dynamic from "next/dynamic";
import type { DoctorOption } from "@/lib/types";

/**
 * Explicit client-loader boundary for the scan island (#71).
 *
 * Server-Component `next/dynamic()` still lists the scanner in the page
 * client-reference entry, so it is transferred on first load. This client
 * boundary produces a real separate browser chunk request on mount.
 *
 * jsqr itself is a further async import inside QrScanner, only after
 * "Open camera" when native BarcodeDetector is unavailable.
 */
export const QrScannerLazy = dynamic(
  () =>
    import("@/components/qr-scanner").then((m) => ({
      default: m.QrScanner,
    })),
  {
    loading: () => (
      <p role="status" className="py-6 text-center text-sm text-muted">
        Loading scanner…
      </p>
    ),
  },
);

export type QrScannerLazyProps = {
  mode?: "volunteer" | "doctor" | "admin";
  doctors?: DoctorOption[];
  disabledReason?: string;
};
