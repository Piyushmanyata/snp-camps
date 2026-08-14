"use client";

import dynamic from "next/dynamic";

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
  campId: string | null;
  disabledReason?: string;
};
