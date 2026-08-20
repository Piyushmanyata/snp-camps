"use client";

import { useRef } from "react";
import { Button } from "@/components/ui";
import type { AadhaarScanner } from "@/components/use-aadhaar-scanner";

export function AadhaarUsbInput({
  scanner,
  requireConsent = true,
}: {
  scanner: AadhaarScanner;
  requireConsent?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const read = () => {
    const payload = inputRef.current?.value ?? "";
    if (inputRef.current) inputRef.current.value = "";
    if (payload) void scanner.readPayload(payload);
  };

  return (
    <div lang="hi-Latn" className="rounded-xl border border-border bg-card p-3">
      <label
        htmlFor="aadhaar-usb-payload"
        className="text-sm font-semibold text-foreground"
      >
        USB Aadhaar scanner
      </label>
      <p className="mt-1 text-xs text-muted">
        Neeche wale box par click karein, ek baar scan karein, aur zaroorat ho
        to Enter dabayein. Raw data turant mit jaata hai.
      </p>
      <div className="mt-2 flex gap-2">
        <input
          ref={inputRef}
          id="aadhaar-usb-payload"
          type="password"
          autoComplete="off"
          inputMode="none"
          disabled={
            (requireConsent && !scanner.hasConsent) || scanner.isReadingUsb
          }
          className="min-h-12 min-w-0 flex-1 rounded-xl border border-border bg-white px-3 font-mono"
          aria-label="USB Aadhaar scanner input"
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            read();
          }}
        />
        <Button
          type="button"
          size="sm"
          disabled={
            (requireConsent && !scanner.hasConsent) || scanner.isReadingUsb
          }
          loading={scanner.isReadingUsb}
          onClick={read}
        >
          Padhein
        </Button>
      </div>
    </div>
  );
}
