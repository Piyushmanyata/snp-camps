"use client";

import { useEffect, useState } from "react";
import {
  setToastListener,
  type ToastPayload,
} from "@/lib/toast-bus";

export function ToastHost() {
  const [current, setCurrent] = useState<ToastPayload | null>(null);

  useEffect(() => {
    setToastListener(setCurrent);
    return () => setToastListener(null);
  }, []);

  useEffect(() => {
    if (!current || current.tone !== "success") return;
    const timer = setTimeout(() => {
      setCurrent(null);
    }, 3000);
    return () => clearTimeout(timer);
    // Remount timer when message changes so rapid updates stay readable.
  }, [current]);

  if (!current) return null;

  if (current.tone === "error") {
    return (
      <button
        type="button"
        role="alert"
        className="fixed left-4 right-4 z-[60] mx-auto min-h-12 max-w-md rounded-xl bg-red-600 px-4 py-3 text-left text-base font-semibold text-white shadow-lg"
        style={{ bottom: "calc(1rem + var(--safe-bottom))" }}
        onClick={() => setCurrent(null)}
      >
        {current.message}
      </button>
    );
  }

  return (
    <div
      role="status"
      className="fixed left-4 right-4 z-[60] mx-auto min-h-12 max-w-md rounded-xl bg-emerald-600 px-4 py-3 text-base font-semibold text-white shadow-lg"
      style={{ bottom: "calc(1rem + var(--safe-bottom))" }}
      key={current.message}
    >
      {current.message}
    </div>
  );
}
