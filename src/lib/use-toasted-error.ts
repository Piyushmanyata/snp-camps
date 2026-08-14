"use client";

import { useCallback, useState } from "react";
import { showErrorToast } from "@/lib/toast-bus";

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
