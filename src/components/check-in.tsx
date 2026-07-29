"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { parsePatientIdFromQr, parseRegistrationNumber } from "@/lib/qr";
import { Button, ErrorBox, Input, WarningBox } from "@/components/ui";
import {
  checkInPatientWithRetries,
  searchRegisteredPatientsWithRetries,
  type RegisteredSearchRow,
} from "@/lib/desk-ops";

type SearchUiState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "results"; rows: RegisteredSearchRow[] }
  | { status: "empty" }
  | { status: "error"; message: string };

function supabaseRpc() {
  const supabase = createClient();
  return async (fn: string, args: Record<string, unknown>) => {
    const result = await supabase.rpc(fn, args);
    return {
      data: result.data,
      error: result.error
        ? {
            message: result.error.message,
            code: result.error.code,
            details: result.error.details,
            hint: result.error.hint,
          }
        : null,
    };
  };
}

/**
 * Find a pre-registered patient by reg number, name, or pasted QR, then print
 * their prescription — which is what puts them in the queue (ADR 0008).
 *
 * Name search exists for the patient who lost their paper and forgot their
 * number; it is a way of reaching Print, never a separate check-in action.
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
  const [searchState, setSearchState] = useState<SearchUiState>({
    status: "idle",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Last patient id chosen from name list — preserved across check-in failure. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchGen = useRef(0);
  const lastSearchQuery = useRef("");

  const runSearch = useCallback(
    async (q: string, gen: number) => {
      if (!campId) return;
      setSearchState({ status: "loading" });
      const outcome = await searchRegisteredPatientsWithRetries({
        campId,
        query: q,
        limit: 10,
        rpc: supabaseRpc(),
        errorContext: "check-in.search",
        errorFallback: "Could not search names. Try again.",
      });
      if (gen !== searchGen.current) return;
      if (!outcome.ok) {
        setSearchState({ status: "error", message: outcome.error });
        return;
      }
      if (outcome.rows.length === 0) {
        setSearchState({ status: "empty" });
        return;
      }
      setSearchState({ status: "results", rows: outcome.rows });
    },
    [campId],
  );

  const runCheckIn = useCallback(
    async (opts: { id?: string; regNo?: number }) => {
      if (busy || !campId) return;
      setBusy(true);
      setError(null);
      if (opts.id) setSelectedId(opts.id);

      const outcome = await checkInPatientWithRetries({
        patientId: opts.id ?? null,
        regNo: opts.regNo ?? null,
        rpc: supabaseRpc(),
        errorContext: "check-in",
        errorFallback: "Could not queue this patient. Try again.",
      });

      if (!outcome.ok) {
        setError(outcome.error);
        setBusy(false);
        return;
      }

      const row = outcome.row;
      setRegInput("");
      setNameQuery("");
      setSearchState({ status: "idle" });
      setSelectedId(null);
      setBusy(false);
      // The desk has exactly one way to queue someone, and it ends in paper
      // (ADR 0008). Finding a patient by name is a way of *reaching* Print,
      // never a separate check-in, so hand straight off to the print sheet.
      router.push(`/print/${row.id}?auto=1`);
    },
    [busy, campId, router],
  );

  useEffect(() => {
    if (!campId) return;
    const q = nameQuery.trim();
    if (q.length < 1) {
      // Invalidate in-flight search; UI derives idle from empty query (no setState).
      searchGen.current += 1;
      lastSearchQuery.current = "";
      return;
    }
    const gen = ++searchGen.current;
    lastSearchQuery.current = q;
    const timer = window.setTimeout(() => {
      void runSearch(q, gen);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [campId, nameQuery, runSearch]);

  function retrySearch() {
    const q = nameQuery.trim() || lastSearchQuery.current;
    if (!q || !campId) return;
    const gen = ++searchGen.current;
    lastSearchQuery.current = q;
    void runSearch(q, gen);
  }

  function retryCheckIn() {
    if (selectedId) {
      void runCheckIn({ id: selectedId });
      return;
    }
    const raw = regInput.trim();
    if (!raw) return;
    if (!/^\d+$/.test(raw)) {
      const asId = parsePatientIdFromQr(raw);
      if (asId) void runCheckIn({ id: asId });
      return;
    }
    const reg = parseRegistrationNumber(raw);
    if (reg !== null) void runCheckIn({ regNo: reg });
  }

  async function onRegSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setSelectedId(null);
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
      <WarningBox>{disabledReason || "No active camp."}</WarningBox>
    );
  }

  const hasQuery = nameQuery.trim().length > 0;
  const visibleResults =
    hasQuery && searchState.status === "results" ? searchState.rows : [];
  const showEmpty = hasQuery && searchState.status === "empty";
  const showSearchError = hasQuery && searchState.status === "error";
  const showSearching = hasQuery && searchState.status === "loading";

  return (
    <div className="space-y-3">
      <p className="prose-help text-sm text-muted">
        Pre-registered patients are <strong className="text-foreground">not</strong>{" "}
        in the queue until their prescription is printed. Find them by reg
        number, name, or paste their patient QR.
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
            Print prescription
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
        {showSearching ? (
          <p className="text-xs text-muted" role="status">
            Searching…
          </p>
        ) : null}
        {visibleResults.length > 0 ? (
          <ul
            className="divide-y divide-border overflow-hidden rounded-xl border border-border"
            aria-label="Matching registered patients"
          >
            {visibleResults.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runCheckIn({ id: m.id })}
                  className="pressable flex min-h-12 w-full flex-col items-start justify-center gap-0.5 px-3 py-3 text-left hover:bg-brand-soft disabled:opacity-50"
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
        ) : null}
        {showEmpty ? (
          <p className="text-xs text-muted" role="status">
            No registered patients match. Names already printed for are hidden.
          </p>
        ) : null}
        {showSearchError ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-danger">{searchState.message}</p>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={retrySearch}
              className="sm:w-auto"
            >
              Try again
            </Button>
          </div>
        ) : null}
      </div>

      <ErrorBox message={error} />
      {error && (selectedId || regInput.trim()) ? (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          loading={busy}
          onClick={retryCheckIn}
          className="sm:w-auto"
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}


