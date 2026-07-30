"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { isNonLatinText } from "@/lib/aadhaar-text";
import type { ParsedAadhaarQr } from "@/lib/aadhaar-qr";
import { formatCampDay } from "@/lib/format-camp-day";
import type { CampDayStats } from "@/lib/types";
import { Button, ErrorBox, Input, Select, WarningBox } from "@/components/ui";
import { useAadhaarScanner } from "@/components/use-aadhaar-scanner";
import { AadhaarCapture } from "@/components/aadhaar-capture";
import type { SelfRegistrationReceiptData } from "@/components/self-registration-receipt";

const SelfRegistrationReceipt = lazy(
  () =>
    import("@/components/self-registration-receipt").then(
      (module) => ({ default: module.SelfRegistrationReceipt }),
    ),
);

type Props = { campId: string; venue: string | null; days: CampDayStats[] };

type ScannedCard = {
  fullName: string;
  gender: string;
  age: number;
  address: string;
  aadhaarLast4: string;
  dateOfBirth: string;
};

/**
 * Patient self-registration by Aadhaar card scan (#113).
 *
 * No OTP and no eKYC provider (ADR 0004): the card is parsed on the device and
 * assumed authentic. The phone number is typed because the QR does not carry
 * one, and no registration SMS is sent — this screen is the receipt.
 */
export function SelfRegistrationFlow({ campId, venue, days }: Props) {
  const openDays = days.filter((day) => !day.is_full);
  const [card, setCard] = useState<ScannedCard | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [dayId, setDayId] = useState(openDays[0]?.id ?? "");
  const [result, setResult] = useState<SelfRegistrationReceiptData | null>(
    null,
  );
  const [deskReferral, setDeskReferral] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const onParsed = useCallback((parsed: ParsedAadhaarQr): boolean => {
    // Every key field is required: without all four the Person key cannot be
    // derived, and a half-filled self-registration is worse than a desk visit.
    if (
      !parsed.fullName ||
      !parsed.gender ||
      parsed.age == null ||
      !parsed.dateOfBirth ||
      !parsed.aadhaarLast4
    ) {
      return false;
    }
    setCard({
      fullName: parsed.fullName,
      gender: parsed.gender,
      age: parsed.age,
      address: parsed.address ?? "",
      aadhaarLast4: parsed.aadhaarLast4,
      dateOfBirth: parsed.dateOfBirth,
    });
    setDisplayName("");
    setError(null);
    return true;
  }, []);

  const scanner = useAadhaarScanner(onParsed);
  const { clearError: clearScanError } = scanner;
  const needsLatinName = Boolean(card && isNonLatinText(card.fullName));

  useEffect(() => {
    if (card) stepHeadingRef.current?.focus();
  }, [card]);

  async function register() {
    if (!card) return;
    if (!dayId) {
      setError("Ek Camp Day chunna zaroori hai.");
      return;
    }
    if (phone.replace(/\D/g, "").length !== 10) {
      setError("10-digit mobile number daalein.");
      return;
    }
    if (needsLatinName && !displayName.trim()) {
      setError("Apna naam English letters mein bhi likhein.");
      return;
    }

    setBusy(true);
    setError(null);
    setDeskReferral(false);
    try {
      const response = await fetch("/api/self-registration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          campId,
          campDayId: dayId,
          phone,
          card: { ...card, displayName: displayName.trim() || null },
        }),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.ok !== true) {
        setDeskReferral(body.deskReferral === true);
        setError(
          typeof body.error === "string"
            ? body.error
            : "Registration nahi ho paaya. Camp desk par madad lein.",
        );
        return;
      }
      setResult({
        patientId: String(body.patientId),
        registrationNumber: Number(body.registrationNumber),
        dayDate: typeof body.dayDate === "string" ? body.dayDate : null,
        statusUrl: String(body.statusUrl),
      });
    } catch {
      setError("Network problem. Dobara try karein ya camp desk par milen.");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Suspense fallback={<p role="status">Receipt taiyaar ho rahi hai…</p>}>
        <SelfRegistrationReceipt result={result} venue={venue} />
      </Suspense>
    );
  }

  return (
    <section aria-labelledby="self-registration-form" className="space-y-5">
      <h2
        ref={stepHeadingRef}
        id="self-registration-form"
        tabIndex={-1}
        className="text-lg font-bold outline-none"
      >
        {card ? "Details confirm karein" : "Aadhaar card scan karein"}
      </h2>

      {error ? (
        <div role="alert">
          <ErrorBox message={error} />
          {deskReferral ? (
            <p className="mt-2 text-sm text-muted">
              Camp desk par volunteer aapki madad karega.
            </p>
          ) : null}
        </div>
      ) : null}

      {!card ? (
        <>
          <p className="text-sm text-muted">
            Aadhaar card ka QR camera ke saamne rakhein — details apne aap bhar
            jaayengi. Agar card paas nahin hai, registration desk se madad lein.
          </p>
          <WarningBox>
            Mobile number Aadhaar QR mein nahi hota — wo aapko khud type karna hoga.
          </WarningBox>

          <AadhaarCapture scanner={scanner} tone="patient" />

          <p className="rounded-xl border border-border p-4 text-sm text-muted">
            Card scan nahi ho raha? Koi baat nahi — camp desk par volunteer aapko manually
            register kar dega.
          </p>
        </>
      ) : (
        <>
          <dl className="space-y-3 rounded-xl border border-border p-4 text-sm">
            {(
              [
                ["Name", card.fullName],
                ["Age", String(card.age)],
                ["Gender", card.gender],
                ["Address", card.address],
                ["Aadhaar", `xxxx xxxx ${card.aadhaarLast4}`],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted">{label}</dt>
                <dd className="font-semibold">{value || "—"}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted">
            Yeh details Aadhaar card se aayi hain aur edit nahi ho sakti. Galti ho to camp
            desk par correction karayein.
          </p>

          {needsLatinName ? (
            <Input
              id="display-name"
              label="Naam English letters mein"
              hint="Card par naam English mein nahi hai. Slip aur naam-search ke liye English spelling chahiye."
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          ) : null}

          <Input
            id="phone"
            label="Mobile number"
            hint="Aadhaar QR mein number nahi hota, isliye khud daalein."
            inputMode="numeric"
            autoComplete="tel"
            maxLength={10}
            value={phone}
            onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 10))}
            required
          />

          <Select
            id="camp-day"
            label="Camp Day"
            hint={`Camp: ${venue || "venue TBA"}.`}
            value={dayId}
            onChange={(event) => setDayId(event.target.value)}
          >
            {openDays.map((day) => (
              <option key={day.id} value={day.id}>
                {formatCampDay(day.day_date)} · {day.seats_left} seats left
              </option>
            ))}
          </Select>

          <Button type="button" disabled={busy} onClick={() => void register()}>
            {busy ? "Register kar rahe hain…" : "Confirm registration"}
          </Button>

          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setCard(null);
              setError(null);
              clearScanError();
            }}
          >
            Dobara scan karein
          </Button>
        </>
      )}
    </section>
  );
}
