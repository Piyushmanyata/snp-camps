"use client";

import { Button, ErrorBox, WarningBox } from "@/components/ui";
import { formatCampDay } from "@/lib/types";
import type { PhoneLinkCandidate } from "@/lib/link-patient-phone";

type Props = {
  candidates: PhoneLinkCandidate[];
  askDesk: boolean;
  loading: boolean;
  error: string | null;
  onSelect: (patientId: string) => void;
  onCancel: () => void;
};

/** Shared household phone disambiguation for OTP login and self-register. */
export function PhoneLinkChooser({
  candidates,
  askDesk,
  loading,
  error,
  onSelect,
  onCancel,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-brand/20 bg-brand-soft/40 p-4">
        <p className="text-sm font-semibold text-foreground">
          Several registrations use this phone
        </p>
        <p className="mt-1 text-xs text-muted">
          A phone number can belong to a household. Choose your registration —
          the one with your name and camp day.
        </p>
      </div>

      {askDesk ? (
        <WarningBox>
          More than ten people share this number. Ask the volunteer desk to link
          your registration.
        </WarningBox>
      ) : null}

      <ul className="space-y-2" role="list" aria-label="Matching registrations">
        {candidates.map((c) => {
          const dayLabel = c.camp_day
            ? formatCampDay(c.camp_day)
            : "Camp day not set";
          return (
            <li key={c.id}>
              <button
                type="button"
                disabled={loading}
                onClick={() => onSelect(c.id)}
                className="pressable flex w-full flex-col items-start gap-0.5 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-brand/40 hover:bg-brand-soft/30 disabled:opacity-60"
              >
                <span className="text-sm font-bold text-foreground">
                  Reg #{c.reg_no} · {c.full_name}
                </span>
                <span className="text-xs text-muted">{dayLabel}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <ErrorBox message={error} />

      <Button
        type="button"
        variant="ghost"
        disabled={loading}
        onClick={onCancel}
      >
        Cancel
      </Button>
    </div>
  );
}
