"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Button,
  Card,
  CollapsibleSection,
  ErrorBox,
  SectionTitle,
  Select,
} from "@/components/ui";
import { ClinicalRecordView } from "@/components/clinical-record-view";

type Item = {
  id: string;
  kind: string;
  outcome: string;
  resolved_at: string;
  events: Array<{ event: string; [key: string]: unknown }>;
  slips: Array<Record<string, unknown>>;
};
export type ClinicalRecord = {
  transcription_id: string;
  reg_no: number;
  patient_name: string;
  camp_name: string;
  data: Record<string, unknown>;
  created_at: string;
  locked_at: string | null;
  archived_at: string | null;
  corrections: Array<Record<string, unknown>>;
  items: Item[];
};

export type ClinicalCampOption = {
  id: string;
  name: string;
  is_active: boolean;
};

type RecordsPage = { records: ClinicalRecord[]; total: number };

export function AdminClinicalRecords({
  initial,
  initialTotal = initial.length,
  initialError = null,
  camps = [],
  activeCampId = null,
}: {
  initial: ClinicalRecord[];
  initialTotal?: number;
  initialError?: string | null;
  camps?: ClinicalCampOption[];
  activeCampId?: string | null;
}) {
  const [records, setRecords] = useState(initial);
  const [total, setTotal] = useState(initialTotal);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [exportError, setExportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [campId, setCampId] = useState(activeCampId ?? "");
  const [reversalItem, setReversalItem] = useState<Item | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reversalDialogRef = useRef<HTMLDialogElement | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const supabase = createClient();

  async function refresh(
    includeArchived = showArchived,
    offset = 0,
    append = false,
    selectedCampId = campId,
  ) {
    if (!selectedCampId) {
      setRecords([]);
      setTotal(0);
      setError(null);
      return;
    }
    setBusy(true);
    const { data, error: rpcError } = await supabase.rpc("admin_clinical_records", {
      p_camp_id: selectedCampId,
      p_include_archived: includeArchived,
      p_limit: 50,
      p_offset: offset,
    });
    if (rpcError) {
      setRecords([]);
      setTotal(0);
      setError("Clinical records could not be loaded.");
    } else {
      const page = (data ?? { records: [], total: 0 }) as RecordsPage;
      setRecords((current) => append ? [...current, ...(page.records ?? [])] : (page.records ?? []));
      setTotal(page.total ?? 0);
      setError(null);
    }
    setBusy(false);
  }

  async function archive(id: string, archived: boolean) {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("admin_archive_transcription", {
      p_transcription_id: id,
      p_archived: archived,
    });
    if (rpcError) setError("Archive state could not be changed.");
    else await refresh();
    setBusy(false);
  }

  useEffect(() => {
    if (!reversalItem) return;
    const dialog = reversalDialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    reasonRef.current?.focus();
  }, [reversalItem]);

  function closeReversalDialog() {
    const itemId = reversalItem?.id;
    const dialog = reversalDialogRef.current;
    if (dialog?.open) dialog.close();
    setReversalItem(null);
    setReason("");
    setReasonError(null);
    if (itemId) {
      window.requestAnimationFrame(() => {
        document.getElementById("reverse-fulfilment-" + itemId)?.focus();
      });
    }
  }

  function openReversalDialog(item: Item) {
    setReason("");
    setReasonError(null);
    setReversalItem(item);
  }

  async function submitReversal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reversalItem || busy) return;
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setReasonError("Enter a reason before reversing this fulfilment.");
      reasonRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("admin_reverse_fulfilment", {
      p_item_id: reversalItem.id,
      p_reason: trimmedReason,
    });
    if (rpcError) {
      setError(
        /only later fulfilment/i.test(rpcError.message)
          ? "Only a later fulfilment can be reversed. This outcome was recorded at the Clinical Desk."
          : "Fulfilment could not be reversed.",
      );
    }
    else {
      await refresh();
      closeReversalDialog();
    }
    setBusy(false);
  }

  function exportUrl(format: "records" | "audit") {
    const params = new URLSearchParams({ format });
    if (campId) params.set("campId", campId);
    if (showArchived) params.set("includeArchived", "1");
    return `/api/admin/exports/clinical.csv?${params.toString()}`;
  }

  async function downloadExport(format: "records" | "audit") {
    setExportError(null);
    if (!campId) {
      setExportError("Select a camp, or activate a camp, before exporting.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(exportUrl(format));
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setExportError(body?.error?.trim() || "Export failed. Try again.");
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const matched = /filename="([^"]+)"/i.exec(disposition);
      const filename =
        matched?.[1] ||
        (format === "records" ? "camp-records.csv" : "clinical-audit.csv");
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      setExportError("Export failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem]">
          <Select
            label="Camp"
            aria-label="Camp for clinical records and export"
            value={campId}
            onChange={(event) => {
              const next = event.target.value;
              setCampId(next);
              void refresh(showArchived, 0, false, next);
            }}
          >
            <option value="">Select a camp</option>
            {camps.map((camp) => (
              <option key={camp.id} value={camp.id}>
                {camp.name}
                {camp.is_active ? " (active)" : ""}
              </option>
            ))}
          </Select>
        </div>
        <Button
          type="button"
          disabled={!campId || busy}
          onClick={() => void downloadExport("records")}
        >
          Download Camp Records (CSV)
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!campId || busy}
          onClick={() => void downloadExport("audit")}
        >
          Download Clinical Audit (CSV)
        </Button>
        <Button type="button" variant="secondary" disabled={busy || !campId} onClick={() => {
          const next = !showArchived;
          setShowArchived(next);
          void refresh(next);
        }}>{showArchived ? "Hide archived" : "Include archived"}</Button>
      </div>
      <ErrorBox message={error || exportError} />
      {error ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void refresh()}>Retry loading records</Button> : null}
      {!campId ? (
        <Card>
          <p className="text-sm text-muted">
            Choose a camp to view clinical records and download exports.
          </p>
        </Card>
      ) : null}
      {campId
        ? records.map((record) => (
        <Card key={record.transcription_id} className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <SectionTitle>#{record.reg_no} · {record.patient_name}</SectionTitle>
              <p className="text-sm text-muted">{record.camp_name} · {new Date(record.created_at).toLocaleString("en-IN")}</p>
            </div>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void archive(record.transcription_id, !record.archived_at)}>
              {record.archived_at ? "Restore" : "Archive"}
            </Button>
          </div>
          <div className="max-h-64 overflow-auto rounded-xl bg-slate-50 p-3">
            <ClinicalRecordView data={record.data} />
          </div>
          <CollapsibleSection
            title={"Correction audit (" + record.corrections.length + ")"}
          >
            <ul className="mt-2 max-h-64 space-y-1 overflow-auto text-sm">
              {record.corrections.map((correction, index) => {
                const createdAt =
                  typeof correction.created_at === "string"
                    ? new Date(correction.created_at).toLocaleString("en-IN")
                    : "";
                const reason =
                  typeof correction.reason === "string" ? correction.reason : "";
                const author =
                  typeof correction.author_name === "string"
                    ? correction.author_name
                    : typeof correction.created_by_name === "string"
                      ? correction.created_by_name
                      : typeof correction.name === "string"
                        ? correction.name
                        : "";
                const parts = [createdAt, reason, author].filter(Boolean);
                return (
                  <li key={String(correction.id ?? `${createdAt}-${index}`)}>
                    {parts.join(" · ") || "Correction"}
                  </li>
                );
              })}
            </ul>
          </CollapsibleSection>
          <div className="space-y-2">
            {record.items.map((item) => (
              <div key={item.id} className="space-y-2 rounded-xl border border-border p-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span><strong>{item.kind.toUpperCase()}</strong> · {item.outcome.replaceAll("_", " ")}</span>
                  {item.outcome === "fulfilled" && item.events.some((event) => event.event === "fulfilled_later") ? <Button id={"reverse-fulfilment-" + item.id} type="button" size="sm" variant="secondary" disabled={busy} onClick={() => openReversalDialog(item)}>Reverse later fulfilment</Button> : null}
                </div>
                <CollapsibleSection
                  title={"Event and slip audit (" + (item.events.length + item.slips.length) + ")"}
                >
                  <div className="mt-2 max-h-64 space-y-3 overflow-auto text-sm">
                    {item.events.length ? (
                      <ul className="space-y-1">
                        {item.events.map((event, index) => {
                          const stamp =
                            typeof event.created_at === "string"
                              ? new Date(event.created_at).toLocaleString("en-IN")
                              : "";
                          return (
                            <li key={String(event.id ?? `${event.event}-${index}`)}>
                              {event.event}
                              {stamp ? ` · ${stamp}` : ""}
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                    {item.slips.length ? (
                      <ul className="space-y-1">
                        {item.slips.map((slip, index) => {
                          const date =
                            typeof slip.date === "string" ? slip.date : "";
                          const venue =
                            typeof slip.venue === "string" ? slip.venue : "";
                          const stamp =
                            typeof slip.issued_at === "string"
                              ? new Date(slip.issued_at).toLocaleString("en-IN")
                              : typeof slip.created_at === "string"
                                ? new Date(slip.created_at).toLocaleString("en-IN")
                                : "";
                          const status =
                            typeof slip.status === "string"
                              ? slip.status.toLowerCase()
                              : "";
                          const cancelled =
                            status === "cancelled" ||
                            status === "superseded" ||
                            status === "replaced" ||
                            Boolean(slip.replaced_by);
                          const line = [date, venue, stamp].filter(Boolean).join(" · ");
                          return (
                            <li key={String(slip.id ?? `${date}-${index}`)}>
                              {line || "Slip"}
                              {cancelled ? " · cancelled" : ""}
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                </CollapsibleSection>
              </div>
            ))}
          </div>
        </Card>
      ))
        : null}
      {campId && records.length < total ? (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => void refresh(showArchived, records.length, true)}
        >
          Load more
        </Button>
      ) : null}
      {campId && !records.length ? (
        <Card>
          <p className="text-sm text-muted">No clinical records in this view.</p>
        </Card>
      ) : null}
      {reversalItem ? (
        <dialog
          ref={reversalDialogRef}
          aria-labelledby="reverse-fulfilment-title"
          aria-describedby="reverse-fulfilment-description"
          aria-modal="true"
          className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-border bg-card p-5 text-foreground shadow-2xl backdrop:bg-black/60 sm:p-6"
          onCancel={(event) => {
            event.preventDefault();
            closeReversalDialog();
          }}
        >
          <h2 id="reverse-fulfilment-title" className="text-lg font-bold">
            Reverse later fulfilment
          </h2>
          <p id="reverse-fulfilment-description" className="mt-1 text-sm text-muted">
            Explain why this fulfilment needs an admin correction.
          </p>
          <form onSubmit={submitReversal} noValidate className="mt-4 space-y-3">
            <label htmlFor="reverse-fulfilment-reason" className="block text-sm font-semibold">
              Reason
            </label>
            <textarea
              ref={reasonRef}
              id="reverse-fulfilment-reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                if (reasonError) setReasonError(null);
              }}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? "reverse-fulfilment-reason-error" : undefined}
              rows={4}
              maxLength={500}
              required
              className="w-full rounded-xl border border-border bg-card px-3.5 py-3 text-base text-foreground outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
            {reasonError ? (
              <p
                id="reverse-fulfilment-reason-error"
                role="alert"
                className="text-[0.8125rem] font-medium text-danger"
              >
                {reasonError}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={closeReversalDialog}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy} loading={busy}>
                Reverse fulfilment
              </Button>
            </div>
          </form>
        </dialog>
      ) : null}
    </div>
  );
}
