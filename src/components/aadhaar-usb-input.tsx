"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const [isReceiving, setIsReceiving] = useState(false);
  const consentMissing = requireConsent && !scanner.hasConsent;
  const isLoading = scanner.isReadingUsb || isReceiving;

  const triggerRead = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setIsReceiving(false);
    const payload = inputRef.current?.value ?? "";
    if (inputRef.current) inputRef.current.value = "";
    if (payload.trim()) {
      void scanner.readPayload(payload);
    }
  }, [scanner]);

  const scheduleRead = useCallback(() => {
    setIsReceiving(true);
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
      <div
        className="relative mt-2 flex min-h-12 items-center rounded-xl border border-border bg-white cursor-pointer"
        onClick={() => {
          if (!consentMissing) inputRef.current?.focus();
        }}
      >
        <input
          ref={inputRef}
          id="aadhaar-usb-payload"
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
          inputMode="none"
          disabled={consentMissing}
          className="absolute inset-0 h-full w-full rounded-xl bg-transparent px-3 text-transparent caret-transparent selection:bg-transparent focus-visible:ring-2 focus-visible:ring-brand/40"
          aria-label="USB Aadhaar scanner input"
          onInput={scheduleRead}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            triggerRead();
          }}
        />
        <div
          className="pointer-events-none flex h-full w-full items-center justify-center gap-2 px-3 py-2.5 text-sm font-semibold"
          aria-hidden="true"
        >
          {isLoading ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 text-brand"
            >
              <Spinner className="h-5 w-5" />
              <span>Card padh rahe hain…</span>
            </div>
          ) : consentMissing ? (
            <span className="text-muted">Pehle consent dein</span>
          ) : (
            <span className="flex items-center gap-2 text-muted">
              <span className="inline-block size-2 rounded-full bg-emerald-500 animate-pulse" />
              Card scan karein…
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
