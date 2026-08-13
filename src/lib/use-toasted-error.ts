"use client";

import { useCallback, useState } from "react";
import { showErrorToast } from "@/lib/toast-bus";

/**
 * Error state that also fires the global error toast when set to a non-null
 * message. One channel for desk surfaces that pair inline/sr-only alert with toast.
 */
export function useToastedError(
  initial: string | null = null,
): [string | null, (message: string | null) => void] {
  const [error, setErrorState] = useState<string | null>(initial);
  const setError = useCallback((message: string | null) => {
    setErrorState(message);
    if (message) showErrorToast(message);
  }, []);
  return [error, setError];
}
