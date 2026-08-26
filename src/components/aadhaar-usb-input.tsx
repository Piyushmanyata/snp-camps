"use client";

import { useCallback, useEffect, useRef } from "react";
import { Spinner } from "@/components/ui";
import type { AadhaarScanner } from "@/components/use-aadhaar-scanner";

export function AadhaarUsbInput({
  scanner,
  requireConsent = true,
}: {
  scanner: AadhaarScanner;
  requireConsent?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consentMissing = requireConsent && !scanner.hasConsent;

  const triggerRead = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const payload = inputRef.current?.value ?? "";
    if (inputRef.current) inputRef.current.value = "";
    if (payload.trim()) {
      void scanner.readPayload(payload);
    }
  }, [scanner]);

  const scheduleRead = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      triggerRead();
    }, 200);
  }, [triggerRead]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!consentMissing) {
      inputRef.current?.focus();
    }
  }, [consentMissing]);

  return (
    <div lang="hi-Latn" className="rounded-xl border border-border bg-card p-3">
      <label
        htmlFor="aadhaar-usb-payload"
        className="text-sm font-semibold text-foreground"
      >
        USB Aadhaar scanner
      </label>
      <p className="mt-1 text-xs text-muted">
        Neeche wale box par click karke card scan karein — scan apne aap load ho jaayega. Raw data turant mit jaata hai.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input
          ref={inputRef}
          id="aadhaar-usb-payload"
          type="password"
          autoComplete="off"
          inputMode="none"
          disabled={consentMissing}
          readOnly={scanner.isReadingUsb}
          className="min-h-12 min-w-0 flex-1 rounded-xl border border-border bg-white px-3 font-mono text-sm placeholder:text-muted focus-visible:ring-2 focus-visible:ring-brand/40"
          placeholder={
            consentMissing
              ? "Pehle consent dein"
              : scanner.isReadingUsb
                ? "Scan padh rahe hain…"
                : "Yahan scan karein…"
          }
          aria-label="USB Aadhaar scanner input"
          onInput={scheduleRead}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            triggerRead();
          }}
        />
        {scanner.isReadingUsb ? (
          <div
            role="status"
            aria-live="polite"
            className="flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-brand-soft px-3.5 text-xs font-bold text-brand"
          >
            <Spinner className="h-4 w-4" />
            <span>Padh rahe hain…</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
