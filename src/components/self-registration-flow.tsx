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
import { genderLabel, type CampDayStats } from "@/lib/types";
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
      nextFieldErrors.dayId = "Please select a camp day.";
    }
    const phoneCheck = validateHouseholdPhone(phone);
    if (!phoneCheck.ok) {
      nextFieldErrors.phone =
        "Enter a valid 10-digit mobile number (starts with 6–9).";
    }
    if (needsLatinName && !displayName.trim()) {
      nextFieldErrors.displayName = "Name in English letters is required.";
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
        signal: AbortSignal.timeout(20_000),
      });
      if (generation !== generationRef.current) return;
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.ok !== true) {
        setDeskReferral(body.deskReferral === true);
        setError(
          typeof body.error === "string"
            ? body.error
            : "Could not complete registration. Please ask for help at the camp desk.",
        );
        return;
      }
      setResult({
        patientId: String(body.patientId),
        registrationNumber: Number(body.registrationNumber),
        dayDate: typeof body.dayDate === "string" ? body.dayDate : null,
        existing: body.existing === true,
      });
    } catch (err) {
      if (generation !== generationRef.current) return;
      const timedOut =
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError");
      setError(
        timedOut
          ? "Request timed out. Please try again."
          : "Network issue. Please try again or ask for help at the camp desk.",
      );
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
      <Suspense fallback={<p role="status">Preparing receipt…</p>}>
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
        {card ? "Confirm details" : "Scan Aadhaar card"}
      </h2>

      {error ? (
        <>
          <ErrorBox message={error} />
          {deskReferral ? (
            <p className="mt-2 text-sm text-muted">
              A volunteer at the camp desk will help you.
            </p>
          ) : null}
        </>
      ) : null}

      {!card ? (
        <>
          <p className="text-sm text-muted">
            Hold Aadhaar card QR in front of camera — details will fill
            automatically. If you do not have your card, please ask for help at
            the registration desk.
          </p>
          <WarningBox>
            Mobile number is not stored in the Aadhaar QR — you will need to type it.
          </WarningBox>

          <AadhaarCapture scanner={scanner} tone="patient" />

          <p className="rounded-xl border border-border p-4 text-sm text-muted">
            Card not scanning? Don&apos;t worry — a volunteer at the camp desk can register
            you manually.
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
                ["Name", card.fullName],
                ["Age", String(card.age)],
                ["Gender", genderLabel(card.gender)],
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
            These details were read from your Aadhaar card and cannot be edited directly. If
            there is an error, please ask for a correction at the camp desk.
          </p>

          {needsLatinName ? (
            <Input
              id="display-name"
              label="Name in English letters"
              hint="Name on card is not in English. English spelling is required for printed slips and search."
              error={fieldErrors.displayName}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          ) : null}

          <Input
            id="phone"
            label="Enter mobile number"
            hint="Aadhaar QR does not contain a phone number, so please enter it manually."
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
            label="Camp day"
            hint={`Camp venue: ${venue || "to be announced"}.`}
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
            {busy ? "Registering…" : "Complete registration"}
          </Button>

          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={rescan}
          >
            Scan again
          </Button>
        </form>
      )}
    </section>
  );
}
