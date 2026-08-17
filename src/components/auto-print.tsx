"use client";

import { useEffect } from "react";

export function AutoPrint() {
  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) window.print();
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
