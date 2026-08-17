"use client";

import { useEffect } from "react";

export function AutoPrint() {
  useEffect(() => {
    let cancelled = false;
    // Older Android WebViews — the cheap tablets this runs on — ship no
    // document.fonts. Without the fallback this throws inside the effect and
    // the error boundary replaces the slip the operator is trying to print.
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (!cancelled) window.print();
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
