"use client";

import { useState } from "react";
import { AadhaarUsbInput } from "@/components/aadhaar-usb-input";
import { useAadhaarScanner } from "@/components/use-aadhaar-scanner";
import { Button, ErrorBox, Input } from "@/components/ui";
import { diffTypedVsCard } from "@/lib/card-identity-diff";
import type { ParsedAadhaarQr } from "@/lib/aadhaar-qr";

type ConfirmRow = {
  outcome: string;
  surviving_reg_no: number | null;
  surviving_name: string | null;
  surviving_age: number | null;
  surviving_gender: string | null;
  typed_full_name: string | null;
  typed_date_of_birth: string | null;
  typed_gender: string | null;
  typed_aadhaar_last4: string | null;
  typed_address: string | null;
};

const DIFF_FIELDS = [
  ["fullName", "Full name"],
  ["dateOfBirth", "Date of birth"],
  ["gender", "Gender"],
  ["aadhaarLast4", "Aadhaar last-4"],
  ["address", "Address"],
] as const;

export function AadhaarConfirmation({
  patientId,
  canOverride,
  onConfirmed,
  onCancel,
}: {
  patientId: string;
  canOverride: boolean;
  onConfirmed: (survivingRegNo?: number | null) => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspect, setInspect] = useState<ConfirmRow | null>(null);
  const [card, setCard] = useState<ParsedAadhaarQr | null>(null);
  const [reason, setReason] = useState("");

  const scanner = useAadhaarScanner(async (parsed) => {
    setCard(parsed);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/desk/aadhaar-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId,
          mode: "inspect",
          fullName: parsed.fullName,
          dateOfBirth: parsed.dateOfBirth,
          gender: parsed.gender,
          aadhaarLast4: parsed.aadhaarLast4,
          address: parsed.address,
        }),
      });
      const json = (await res.json()) as {
        data: ConfirmRow | null;
        error: { message: string } | null;
      };
      if (!res.ok || !json.data) {
        setError(json.error?.message || "Could not read card. Please scan again.");
        return false;
      }
      setInspect(json.data);
      return true;
    } catch {
      setError("Network issue. Check your connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }, undefined, { initialConsent: true });

  async function commit() {
    if (!card) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/desk/aadhaar-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId,
          mode: "commit",
          fullName: card.fullName,
          dateOfBirth: card.dateOfBirth,
          gender: card.gender,
          aadhaarLast4: card.aadhaarLast4,
          address: card.address,
        }),
      });
      const json = (await res.json()) as {
        data: ConfirmRow | null;
        error: { message: string } | null;
      };
      if (!res.ok || !json.data) {
        setError(json.error?.message || "Could not confirm. Please try again.");
        return;
      }
      onConfirmed(json.data.surviving_reg_no);
    } catch {
      setError("Network issue. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function override() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/desk/aadhaar-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId,
          mode: "override",
          reason,
        }),
      });
      const json = (await res.json()) as {
        data: ConfirmRow | null;
        error: { message: string } | null;
      };
      if (!res.ok || !json.data) {
        setError(json.error?.message || "Could not skip confirmation. Please try again.");
        return;
      }
      onConfirmed(json.data.surviving_reg_no);
    } catch {
      setError("Network issue. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const typed = {
    fullName: inspect?.typed_full_name || "",
    dateOfBirth: inspect?.typed_date_of_birth || "",
    gender: inspect?.typed_gender || "",
    aadhaarLast4: inspect?.typed_aadhaar_last4 || "",
    address: inspect?.typed_address || "",
  };
  const cardFields = {
    fullName: card?.fullName || "",
    dateOfBirth: card?.dateOfBirth || "",
    gender: card?.gender || "",
    aadhaarLast4: card?.aadhaarLast4 || "",
    address: card?.address || "",
  };
  const diff = inspect && card ? diffTypedVsCard(typed, cardFields) : null;

  return (
    <div
      className="mt-3 space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-3"
      data-testid="aadhaar-confirmation"
    >
      <p className="text-sm font-semibold text-amber-950">
        Manual exception — scan Aadhaar card first
      </p>
      {!inspect ? (
        <AadhaarUsbInput scanner={scanner} requireConsent={false} />
      ) : null}
      {diff ? (
        <table className="w-full text-sm" data-testid="aadhaar-confirmation-diff">
          <thead>
            <tr className="text-muted">
              <th scope="col" className="text-left font-normal">
                Field
              </th>
              <th scope="col" className="text-left font-normal">
                Entered
              </th>
              <th scope="col" className="text-left font-normal">
                Card
              </th>
            </tr>
          </thead>
          <tbody>
            {DIFF_FIELDS.map(([field, label]) => (
              <tr key={field} data-changed={diff.changed.includes(field)}>
                <th scope="row" className="text-left font-normal text-muted">
                  {label}
                </th>
                <td>{typed[field]}</td>
                <td className={diff.changed.includes(field) ? "font-bold" : ""}>
                  {cardFields[field]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {inspect?.outcome === "collision" ? (
        <p className="text-sm font-medium text-amber-950">
          This card is already linked to reg #{inspect.surviving_reg_no}{" "}
          {inspect.surviving_name} · {inspect.surviving_age} ·{" "}
          {inspect.surviving_gender}. Is this the same person? If yes, accept
          below.
        </p>
      ) : null}
      <ErrorBox message={error} />
      {inspect ? (
        <Button
          type="button"
          disabled={busy}
          loading={busy}
          data-testid="aadhaar-confirmation-accept"
          onClick={() => void commit()}
        >
          Update from card and print
        </Button>
      ) : null}
      {canOverride ? (
        <div className="space-y-2">
          <Input
            label="Reason for skipping confirmation"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !reason.trim()}
            data-testid="aadhaar-confirmation-override"
            onClick={() => void override()}
          >
            Skip confirmation
          </Button>
        </div>
      ) : (
        <p className="text-xs text-amber-900">
          Volunteers cannot skip confirmation.
        </p>
      )}
      <Button type="button" variant="ghost" onClick={onCancel}>
        Go back
      </Button>
    </div>
  );
}
