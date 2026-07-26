"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { parsePatientIdFromQr, parseRegistrationNumber } from "@/lib/qr";
import { Button, ErrorBox, Input, SuccessBox } from "@/components/ui";
import { mapDbError } from "@/lib/public-error";

type CheckInRow = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  already_waiting: boolean;
  doctor_name: string | null;
  error_code: string | null;
};

type SearchRow = {
  id: string;
  reg_no: number;
  full_name: string;
  age: number | null;
  address: string | null;
};

/**
 * Desk check-in: reg number, name search, or paste QR.
 * All paths call check_in_patient (#46).
 */
export function CheckIn({
  campId,
  disabledReason,
}: {
  campId: string | null;
  disabledReason?: string;
}) {
  const router = useRouter();
  const uid = useId().replace(/:/g, "");
  const [regInput, setRegInput] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  const [matches, setMatches] = useState<SearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const searchGen = useRef(0);

  const runCheckIn = useCallback(
    async (opts: { id?: string; regNo?: number }) => {
      if (busy || !campId) return;
      setBusy(true);
      setError(null);
      setSuccess(null);
      try {
        const supabase = createClient();
        const { data, error: err } = await supabase.rpc("check_in_patient", {
          p_patient_id: opts.id ?? null,
          p_reg_no: opts.regNo ?? null,
        });
        if (err) {
          setError(
            mapDbError(err, {
              context: "check-in",
              fallback: "Could not check in this patient. Try again.",
            }),
          );
          return;
        }
        const row = (Array.isArray(data) ? data[0] : data) as CheckInRow | null;
        if (!row) {
          setError("Check-in failed — no row returned.");
          return;
        }
        if (row.error_code === "already_seen" || row.queue_status === "seen") {
          setError(
            row.doctor_name
              ? `Already seen by ${row.doctor_name}`
              : "Already seen",
          );
          return;
        }
        setSuccess(
          row.already_waiting
            ? `#${row.reg_no} ${row.full_name} is already in the queue.`
            : `#${row.reg_no} ${row.full_name} checked in — ab line mein hain.`,
        );
        setRegInput("");
        setNameQuery("");
        setMatches([]);
        router.refresh();
      } catch {
        setError("Could not check in. Check the connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [busy, campId, router],
  );

  useEffect(() => {
    if (!campId) return;
    const q = nameQuery.trim();
    if (q.length < 1) return;
    const gen = ++searchGen.current;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const supabase = createClient();
        const { data, error: err } = await supabase.rpc(
          "search_registered_patients",
          {
            p_camp_id: campId,
            p_query: q,
            p_limit: 10,
          },
        );
        if (gen !== searchGen.current) return;
        setMatches(err ? [] : ((data || []) as SearchRow[]));
      } catch {
        if (gen === searchGen.current) setMatches([]);
      } finally {
        if (gen === searchGen.current) setSearching(false);
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [campId, nameQuery]);

  const visibleMatches = nameQuery.trim().length > 0 ? matches : [];

  async function onRegSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setSuccess(null);
    const raw = regInput.trim();
    if (!raw) {
      setError("Enter a registration number or paste a patient QR link.");
      return;
    }
    if (!/^\d+$/.test(raw)) {
      const asId = parsePatientIdFromQr(raw);
      if (asId) {
        await runCheckIn({ id: asId });
        return;
      }
      setError("Enter registration number (e.g. 1001) or paste QR link.");
      return;
    }
    const reg = parseRegistrationNumber(raw);
    if (reg === null) {
      setError("Enter a valid registration number.");
      return;
    }
    await runCheckIn({ regNo: reg });
  }

  if (disabledReason || !campId) {
    return (
      <div
        className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        role="status"
      >
        {disabledReason || "No active camp."}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="prose-help text-sm text-muted">
        Pre-registered patients are <strong className="text-foreground">not</strong>{" "}
        in the queue until check-in. Use reg number, name, or scan their desk slip.
      </p>

      <form onSubmit={onRegSubmit} className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="sm:flex-1">
            <Input
              id={`checkin-reg-${uid}`}
              label="Registration number"
              inputMode="numeric"
              autoComplete="off"
              placeholder="e.g. 1001"
              value={regInput}
              onChange={(e) => setRegInput(e.target.value)}
              disabled={busy}
            />
          </div>
          <Button
            type="submit"
            disabled={busy}
            loading={busy}
            className="sm:w-auto sm:shrink-0"
          >
            Check in
          </Button>
        </div>
      </form>

      <div className="space-y-2">
        <Input
          id={`checkin-name-${uid}`}
          label="Name search"
          autoComplete="off"
          placeholder="Start typing a name…"
          value={nameQuery}
          onChange={(e) => setNameQuery(e.target.value)}
          disabled={busy}
        />
        {searching ? (
          <p className="text-xs text-muted" role="status">
            Searching…
          </p>
        ) : null}
        {visibleMatches.length > 0 ? (
          <ul
            className="divide-y divide-border overflow-hidden rounded-xl border border-border"
            role="listbox"
            aria-label="Matching registered patients"
          >
            {visibleMatches.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  disabled={busy}
                  onClick={() => void runCheckIn({ id: m.id })}
                  className="pressable flex w-full flex-col items-start gap-0.5 px-3 py-3 text-left hover:bg-brand-soft disabled:opacity-50"
                >
                  <span className="font-semibold text-foreground">
                    <span className="tabular text-brand">#{m.reg_no}</span>
                    {" · "}
                    {m.full_name}
                  </span>
                  <span className="text-xs text-muted">
                    {m.age != null ? `Age ${m.age}` : "Age —"}
                    {m.address ? ` · ${m.address}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : nameQuery.trim().length > 0 && !searching ? (
          <p className="text-xs text-muted" role="status">
            No registered patients match. Already checked-in names are hidden.
          </p>
        ) : null}
      </div>

      <ErrorBox message={error} />
      {success ? <SuccessBox message={success} /> : null}
    </div>
  );
}
