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
  }, [current]);

  if (!current) return null;

  if (current.tone === "error") {
    return (
      <div role="alert" className="app-toast mx-auto max-w-md">
        <button
          type="button"
          className="pressable min-h-12 w-full rounded-xl bg-danger px-4 py-3 text-left text-base font-semibold text-white shadow-lg"
          onClick={() => setCurrent(null)}
        >
          {current.message}
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="app-toast mx-auto min-h-12 max-w-md rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white shadow-lg"
      key={current.message}
    >
      {current.message}
    </div>
  );
}
