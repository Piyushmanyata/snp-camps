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
import { createRequestId } from "@/lib/request-id";
import { validateHouseholdPhone } from "@/lib/phone";
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

type FieldErrors = Partial<
  Record<"displayName" | "phone" | "dayId", string>
>;

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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const requestIdRef = useRef(createRequestId());
  const generationRef = useRef(0);

  const onParsed = useCallback((parsed: ParsedAadhaarQr): boolean => {
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
    setFieldErrors({});
    requestIdRef.current = createRequestId();
    return true;
  }, []);

  const scanner = useAadhaarScanner(onParsed);
  const { clearError: clearScanError } = scanner;
  const needsLatinName = Boolean(card && isNonLatinText(card.fullName));

  useEffect(() => {
    if (card) stepHeadingRef.current?.focus();
  }, [card]);

  useEffect(() => {
    const firstInvalidId = ["display-name", "phone", "camp-day"].find(
      (id) =>
        (id === "display-name" && fieldErrors.displayName) ||
        (id === "phone" && fieldErrors.phone) ||
        (id === "camp-day" && fieldErrors.dayId),
    );
    if (firstInvalidId) {
      document.getElementById(firstInvalidId)?.focus();
    }
  }, [fieldErrors]);

  async function register() {
    if (!card || busy || busyRef.current) return;

    const nextFieldErrors: FieldErrors = {};
    if (!dayId) {
      nextFieldErrors.dayId = "Camp ka din chunna zaroori hai.";
    }
    const phoneCheck = validateHouseholdPhone(phone);
    if (!phoneCheck.ok) {
      nextFieldErrors.phone =
        "10-digit mobile number daalein (6–9 se shuru). Dummy numbers nahi chalenge.";
    }
    if (needsLatinName && !displayName.trim()) {
      nextFieldErrors.displayName = "Naam English letters mein likhna zaroori hai.";
    }
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      setError(null);
      return;
    }
    if (!phoneCheck.ok) return;
    const normalizedPhone = phoneCheck.phone;

    const generation = ++generationRef.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setDeskReferral(false);
    try {
      const response = await fetch("/api/self-registration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: requestIdRef.current,
          campId,
          campDayId: dayId,
          phone: normalizedPhone,
          card: { ...card, displayName: displayName.trim() || null },
        }),
      });
      if (generation !== generationRef.current) return;
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
        statusUrl:
          typeof body.statusUrl === "string" && body.statusUrl
            ? body.statusUrl
            : null,
      });
    } catch {
      if (generation !== generationRef.current) return;
      setError("Network problem. Dobara try karein ya camp desk par milen.");
    } finally {
      if (generation === generationRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  function rescan() {
    if (busy) return;
    generationRef.current += 1;
    setCard(null);
    setDisplayName("");
    setError(null);
    setFieldErrors({});
    setDeskReferral(false);
    requestIdRef.current = createRequestId();
    clearScanError();
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
        <>
          <ErrorBox message={error} />
          {deskReferral ? (
            <p className="mt-2 text-sm text-muted">
              Camp desk par volunteer aapki madad karega.
            </p>
          ) : null}
        </>
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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void register();
          }}
          noValidate
          aria-busy={busy}
          className="space-y-4"
        >
          <dl className="space-y-3 rounded-xl border border-border p-4 text-sm">
            {(
              [
                ["Naam", card.fullName],
                ["Umar", String(card.age)],
                ["Ling", card.gender],
                ["Pata", card.address],
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
              error={fieldErrors.displayName}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          ) : null}

          <Input
            id="phone"
            label="Mobile number daalein"
            hint="Aadhaar QR mein number nahi hota, isliye khud daalein."
            error={fieldErrors.phone}
            inputMode="numeric"
            autoComplete="tel"
            maxLength={10}
            value={phone}
            onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 10))}
            required
          />

          <Select
            id="camp-day"
            required
            aria-invalid={fieldErrors.dayId ? true : undefined}
            aria-describedby={
              [fieldErrors.dayId ? "camp-day-error" : null, "camp-day-hint"]
                .filter(Boolean)
                .join(" ") || undefined
            }
            label="Camp ka din"
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
          {fieldErrors.dayId ? (
            <p
              id="camp-day-error"
              role="alert"
              className="-mt-2 text-[0.8125rem] font-medium text-danger"
            >
              {fieldErrors.dayId}
            </p>
          ) : null}

          <Button type="submit" disabled={busy}>
            {busy ? "Registration ho rahi hai…" : "Registration pakki karein"}
          </Button>

          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={rescan}
          >
            Dobara scan karein
          </Button>
        </form>
      )}
    </section>
  );
}
