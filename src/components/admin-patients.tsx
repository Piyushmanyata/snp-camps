"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { parseRegistrationNumber } from "@/lib/qr";
import { formatCampDay, queueLabel, queueTone } from "@/lib/types";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Input,
  Stat,
  SuccessBox,
} from "@/components/ui";
import {
  clearDeskPasscode,
  storeDeskPasscode,
} from "@/lib/desk-passcode";
import {
  isPasscodeNeverIssued,
  PASSCODE_NEVER_ISSUED_MARKER,
} from "@/lib/passcode-issued";
import { mapDbError } from "@/lib/public-error";

export type AdminPatientRow = {
  id: string;
  user_id: string | null;
  reg_no: number;
  full_name: string;
  phone: string | null;
  queue_status: string;
  gender: string | null;
  age: number | null;
  created_at: string;
  camp_id: string;
  camps: { name: string } | null;
  day_date?: string | null;
  created_by?: string | null;
  checked_in_by?: string | null;
  seen_by?: string | null;
  queued_at?: string | null;
  seen_at?: string | null;
  volunteer_name?: string | null;
  checked_in_by_name?: string | null;
  doctor_name?: string | null;
  /** Null = never issued under the current scheme. */
  passcode_issued_at?: string | null;
};

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function fmtTs(iso: string | null | undefined) {
  if (!iso) return null;
  try {
    return TIMESTAMP_FORMATTER.format(new Date(iso));
  } catch {
    return null;
  }
}

function waitMinutes(
  queuedAt: string | null | undefined,
  seenAt: string | null | undefined,
  createdAt: string | null | undefined,
) {
  const end = seenAt ? new Date(seenAt).getTime() : NaN;
  const start = queuedAt
    ? new Date(queuedAt).getTime()
    : createdAt
      ? new Date(createdAt).getTime()
      : NaN;
  if (!Number.isFinite(end) || !Number.isFinite(start) || end < start) {
    return null;
  }
  return Math.round((end - start) / 60_000);
}

function mapRows(
  data: Record<string, unknown>[],
): AdminPatientRow[] {
  return data.map((patient) => {
    const camp = patient.camps as
      | { name: string }
      | { name: string }[]
      | null;
    const day = patient.camp_days as
      | { day_date: string }
      | { day_date: string }[]
      | null;
    const volunteer = patient.volunteer as
      | { full_name: string }
      | { full_name: string }[]
      | null;
    const checkedInByRel = patient.checked_in_by_profile as
      | { full_name: string }
      | { full_name: string }[]
      | null;
    const doctor = patient.doctor as
      | { full_name: string }
      | { full_name: string }[]
      | null;
    const createdBy = (patient.created_by as string | null) ?? null;
    const checkedInBy = (patient.checked_in_by as string | null) ?? null;
    const seenBy = (patient.seen_by as string | null) ?? null;
    const volunteerName = Array.isArray(volunteer)
      ? volunteer[0]?.full_name ?? null
      : volunteer?.full_name ?? null;
    const checkedInByName = Array.isArray(checkedInByRel)
      ? checkedInByRel[0]?.full_name ?? null
      : checkedInByRel?.full_name ?? null;
    const doctorName = Array.isArray(doctor)
      ? doctor[0]?.full_name ?? null
      : doctor?.full_name ?? null;
    return {
      id: patient.id as string,
      user_id: (patient.user_id as string | null) ?? null,
      reg_no: patient.reg_no as number,
      full_name: patient.full_name as string,
      phone: (patient.phone as string | null) ?? null,
      queue_status: patient.queue_status as string,
      gender: (patient.gender as string | null) ?? null,
      age: (patient.age as number | null) ?? null,
      created_at: patient.created_at as string,
      camp_id: patient.camp_id as string,
      camps: Array.isArray(camp) ? camp[0] ?? null : camp,
      day_date: Array.isArray(day)
        ? day[0]?.day_date ?? null
        : day?.day_date ?? null,
      created_by: createdBy,
      checked_in_by: checkedInBy,
      seen_by: seenBy,
      queued_at: (patient.queued_at as string | null) ?? null,
      seen_at: (patient.seen_at as string | null) ?? null,
      volunteer_name: volunteerName,
      checked_in_by_name: checkedInByName,
      doctor_name: doctorName,
      passcode_issued_at:
        (patient.passcode_issued_at as string | null | undefined) ?? null,
    };
  });
}

const SELECT =
  "id, user_id, reg_no, full_name, phone, queue_status, gender, age, created_at, camp_id, created_by, checked_in_by, seen_by, queued_at, seen_at, passcode_issued_at, camps(name), camp_days(day_date), volunteer:profiles!created_by(full_name), checked_in_by_profile:profiles!checked_in_by(full_name), doctor:profiles!seen_by(full_name)";

export function AdminPatients({
  initial,
  totalCount,
  avgWaitMinutes = null,
  showAttribution = true,
}: {
  initial: AdminPatientRow[];
  totalCount?: number;
  avgWaitMinutes?: number | null;
  showAttribution?: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<
    "all" | "registered" | "waiting" | "seen"
  >("all");
  const [page, setPage] = useState(0);
  const isDefaultView = !q.trim() && filter === "all" && page === 0;
  const [snapshot, setSnapshot] = useState<{
    source: AdminPatientRow[];
    rows: AdminPatientRow[];
    total: number;
    isDefault: boolean;
  } | null>(null);

  const current =
    snapshot?.source === initial && (!isDefaultView || snapshot.isDefault)
      ? snapshot
      : {
          source: initial,
          rows: initial,
          total: totalCount ?? initial.length,
          isDefault: true,
        };

  const rows = current.rows;
  const total = current.total;
  const [loading, setLoading] = useState(false);
  const isSearching = loading && !isDefaultView;
  const requestId = useRef(0);

  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [accountBusyId, setAccountBusyId] = useState<string | null>(null);
  const [credential, setCredential] = useState<{
    rowId: string;
    regNo: number;
    /** Desk-slip passcode (Auth password); shown once after issue/reissue. */
    passcode: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const credentialHeadingRef = useRef<HTMLHeadingElement>(null);
  const mutationBusy =
    deletingId !== null || accountBusyId !== null || credential !== null;

  useEffect(() => {
    if (credential) credentialHeadingRef.current?.focus();
  }, [credential]);

  useEffect(() => {
    if (isDefaultView) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const currentRequest = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const supabase = createClient();
        let query = supabase
          .from("patients")
          .select(SELECT, { count: "exact" })
          .order("created_at", { ascending: false })
          .range(page * 50, page * 50 + 49);

        if (filter !== "all") query = query.eq("queue_status", filter);

        const term = q.trim().toLowerCase();
        if (term) {
          if (/^\d+$/.test(term)) {
            const regNo = parseRegistrationNumber(term);
            const phone = term.slice(-10);
            const filters = [];
            if (regNo !== null) filters.push("reg_no.eq." + regNo);
            if (phone.length === 10) {
              filters.push("phone_normalized.eq." + phone);
            }
            if (!filters.length) {
              setSnapshot({
                source: initial,
                rows: [],
                total: 0,
                isDefault: false,
              });
              return;
            }
            query = query.or(filters.join(","));
          } else {
            const escaped = term.replace(/[%_]/g, "\\$&");
            query = query.ilike("full_name_normalized", "%" + escaped + "%");
          }
        }

        query = query.abortSignal(controller.signal);
        const { data, count, error: queryError } = await query;
        if (currentRequest !== requestId.current) return;
        if (queryError) {
          setError("Patient search failed. Try again.");
          return;
        }

        setSnapshot({
          source: initial,
          rows: mapRows((data || []) as Record<string, unknown>[]),
          total: count ?? 0,
          isDefault: false,
        });
      } catch {
        if (currentRequest === requestId.current && !controller.signal.aborted) {
          setError("Patient search failed. Check your connection and try again.");
        }
      } finally {
        if (currentRequest === requestId.current) setLoading(false);
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      requestId.current += 1;
    };
  }, [filter, initial, isDefaultView, page, q]);

  async function removePatient(row: AdminPatientRow) {
    if (mutationBusy) return;
    const ok = window.confirm(
      `Remove registration #${row.reg_no} for ${row.full_name}?\nThe registration is permanently deleted; any login account is preserved.`,
    );
    if (!ok) return;

    setDeletingId(row.id);
    setError(null);
    try {
      const supabase = createClient();
      const { error: err } = await supabase
        .from("patients")
        .delete()
        .eq("id", row.id);

      if (err) {
        setError(
          mapDbError(err, {
            context: "admin-patients.delete",
            fallback: "Could not remove this patient. Try again.",
          }),
        );
        return;
      }

      setSnapshot((prev) => {
        const usePrevious =
          prev?.source === initial && (!isDefaultView || prev.isDefault);
        const currentRows = usePrevious ? prev.rows : initial;
        const currentTotal = usePrevious
          ? prev.total
          : (totalCount ?? initial.length);
        return {
          source: initial,
          rows: currentRows.filter((p) => p.id !== row.id),
          total: Math.max(0, currentTotal - 1),
          isDefault: isDefaultView,
        };
      });
      router.refresh();
    } catch {
      setError("Could not remove this patient. Check your connection and try again.");
    } finally {
      setDeletingId(null);
    }
  }

  async function provisionLogin(row: AdminPatientRow) {
    if (mutationBusy) return;
    const action = row.user_id ? "reissue" : "issue";
    if (
      !window.confirm(
        `${action === "reissue" ? "Reissue" : "Issue"} desk-slip passcode for #${row.reg_no} ${row.full_name}? The previous passcode will stop working.`,
      )
    ) {
      return;
    }
    setAccountBusyId(row.id);
    setError(null);
    try {
      const response = await fetch("/api/patient-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: row.id,
          regNo: row.reg_no,
          adminProvision: true,
          returnCredentials: true,
          notify: false,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        password?: string;
        userId?: string;
        regNo?: number;
      };
      if (!response.ok || !result.password) {
        setError(result.error || "Passcode could not be issued or reissued.");
        return;
      }
      storeDeskPasscode(row.id, result.password);
      setCredential({
        rowId: row.id,
        regNo: result.regNo ?? row.reg_no,
        passcode: result.password,
      });
      setCopied(false);
      setSnapshot((prev) => {
        const sourceRows = prev?.source === initial ? prev.rows : initial;
        return {
          source: initial,
          rows: sourceRows.map((patient) =>
            patient.id === row.id
              ? {
                  ...patient,
                  user_id: result.userId ?? patient.user_id,
                  // Successful issue/reissue stamps passcode_issued_at server-side.
                  passcode_issued_at: new Date().toISOString(),
                }
              : patient,
          ),
          total:
            prev?.source === initial
              ? prev.total
              : (totalCount ?? initial.length),
          isDefault:
            prev?.source === initial ? prev.isDefault : isDefaultView,
        };
      });
    } catch {
      setError("Could not manage this passcode. Check your connection and try again.");
    } finally {
      setAccountBusyId(null);
    }
  }

  async function copyCredential() {
    if (!credential) return;
    try {
      await navigator.clipboard.writeText(
        `Patient login\nReg #${credential.regNo}\nPasscode: ${credential.passcode}`,
      );
      setCopied(true);
      setError(null);
    } catch {
      setCopied(false);
      setError("Could not copy. Select the passcode manually.");
    }
  }

  return (
    <div className="space-y-3">
      {avgWaitMinutes != null && !Number.isNaN(avgWaitMinutes) ? (
        <div className="grid grid-cols-1 gap-2 sm:max-w-xs">
          <Stat
            label="Avg wait (queue → doctor)"
            value={
              avgWaitMinutes < 1
                ? "< 1 min"
                : `${Math.round(avgWaitMinutes)} min`
            }
            tone="wait"
          />
        </div>
      ) : null}

      <div className="mb-3 space-y-3">
        <Input
          label="Filter list"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
            setError(null);
          }}
          placeholder="Name, 10-digit phone, or exact reg no"
        />
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Filter by status"
        >
          {(
            [
              ["all", "All"],
              ["registered", "Registered"],
              ["waiting", "In queue"],
              ["seen", "Doctor seen"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => {
                setFilter(key);
                setPage(0);
                setError(null);
              }}
              className={`pressable min-h-9 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                filter === key
                  ? "bg-brand text-white shadow-sm"
                  : "border border-border bg-white text-muted hover:bg-brand-soft hover:text-brand"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <ErrorBox message={error} />
      {credential ? (
        <section
          aria-labelledby="patient-credential-heading"
          className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3"
        >
          <SuccessBox message="Desk-slip passcode is ready. Print the slip or save it before dismissing." />
          <h3
            id="patient-credential-heading"
            ref={credentialHeadingRef}
            tabIndex={-1}
            className="text-sm font-bold text-amber-950"
          >
            Passcode shown once — print on desk slip
          </h3>
          <p className="text-sm text-amber-950">
            Reg <strong>#{credential.regNo}</strong> · passcode{" "}
            <strong className="font-mono" translate="no">
              {credential.passcode}
            </strong>
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/print/${credential.rowId}?auto=1`}
              className="pressable inline-flex min-h-9 items-center justify-center rounded-xl bg-brand px-3 text-xs font-semibold text-white shadow-sm hover:bg-brand-dark"
            >
              Print desk slip
            </Link>
            <Button type="button" size="sm" className="w-auto" onClick={() => void copyCredential()}>
              {copied ? "Copied" : "Copy login"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="w-auto"
              onClick={() => {
                if (
                  window.confirm(
                    "Have you printed the slip or securely shared this passcode?",
                  )
                ) {
                  clearDeskPasscode(credential.rowId);
                  setCredential(null);
                  setCopied(false);
                }
              }}
            >
              I saved it
            </Button>
          </div>
        </section>
      ) : null}

      {isSearching ? (
        <p className="py-8 text-center text-sm text-muted" role="status">
          Searching patients…
        </p>
      ) : !rows.length ? (
        <EmptyState>
          {isDefaultView
            ? "No patients registered yet."
            : "No patients match your search or filter."}
        </EmptyState>
      ) : (
        <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto">
          {rows.map((r) => {
            const wait = waitMinutes(r.queued_at, r.seen_at, r.created_at);
            const createdAt = showAttribution ? fmtTs(r.created_at) : null;
            const queuedAt = showAttribution ? fmtTs(r.queued_at) : null;
            const seenAt = showAttribution ? fmtTs(r.seen_at) : null;
            return (
              <li
                key={r.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">
                    <span className="tabular text-brand">#{r.reg_no}</span>{" "}
                    {r.full_name}
                  </p>
                  {isPasscodeNeverIssued(r.passcode_issued_at) ? (
                    <p
                      className="mt-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-950"
                      role="status"
                    >
                      {PASSCODE_NEVER_ISSUED_MARKER}
                    </p>
                  ) : null}
                  <p className="truncate text-xs text-muted">
                    {[
                      r.day_date ? formatCampDay(r.day_date) : null,
                      r.phone || null,
                      r.age != null ? `${r.age}y` : null,
                      r.gender,
                      r.camps?.name,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </p>
                  {showAttribution ? (
                    <div className="mt-1.5 space-y-0.5 text-xs text-muted">
                      <p>
                        <span className="font-semibold text-foreground/70">
                          Registered
                        </span>
                        {createdAt ? ` · ${createdAt}` : ""}
                        {r.volunteer_name
                          ? ` · by ${r.volunteer_name}`
                          : r.created_by
                            ? " · by staff"
                            : " · self / walk-in"}
                      </p>
                      {r.queued_at ? (
                        <p>
                          <span className="font-semibold text-foreground/70">
                            Queued
                          </span>
                          {queuedAt ? ` · ${queuedAt}` : ""}
                          {r.checked_in_by_name
                            ? ` · by ${r.checked_in_by_name}`
                            : r.checked_in_by
                              ? " · by staff"
                              : ""}
                        </p>
                      ) : null}
                      {r.queue_status === "seen" || r.seen_at ? (
                        <p>
                          <span className="font-semibold text-foreground/70">
                            Doctor seen
                          </span>
                          {seenAt ? ` · ${seenAt}` : ""}
                          {r.doctor_name
                            ? ` · Dr ${r.doctor_name}`
                            : r.seen_by
                              ? " · doctor"
                              : ""}
                          {wait != null ? ` · wait ${wait} min` : ""}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge tone={queueTone(r.queue_status)}>
                    {queueLabel(r.queue_status)}
                  </Badge>
                  <Link
                    href={`/print/${r.id}`}
                    className="pressable rounded-lg border border-border bg-white px-2.5 py-2 text-sm font-semibold text-brand shadow-sm hover:bg-brand-soft"
                  >
                    Print
                  </Link>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="w-auto"
                    disabled={mutationBusy}
                    loading={accountBusyId === r.id}
                    onClick={() => void provisionLogin(r)}
                  >
                    {accountBusyId === r.id
                      ? "Working…"
                      : r.user_id
                        ? "Reissue passcode"
                        : "Issue passcode"}
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    className="w-auto"
                    disabled={mutationBusy}
                    loading={deletingId === r.id}
                    onClick={() => removePatient(r)}
                  >
                    {deletingId === r.id ? "Removing…" : "Remove registration"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {total > 50 ? (
        <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="w-auto"
            disabled={page === 0 || isSearching}
            onClick={() => {
              setPage((value) => Math.max(0, value - 1));
              setError(null);
            }}
          >
            Previous
          </Button>
          <span className="text-xs text-muted">
            Page {page + 1} of {Math.ceil(total / 50)}
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="w-auto"
            disabled={(page + 1) * 50 >= total || isSearching}
            onClick={() => {
              setPage((value) => value + 1);
              setError(null);
            }}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
