"use client";

import { useEffect, useRef } from "react";

export function Toast({
  message,
  duration = 3000,
  onClose,
}: {
  message: string;
  duration?: number;
  onClose: () => void;
}) {
  const cb = useRef(onClose);

  useEffect(() => {
    cb.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const timer = setTimeout(() => {
      cb.current();
    }, duration);
    return () => clearTimeout(timer);
  }, [duration]);

  return (
    <div className="toast" role="status" aria-live="polite">
      {message}
    </div>
  );
}
