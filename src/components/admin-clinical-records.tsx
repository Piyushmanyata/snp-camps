"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { encodeCsvCell } from "@/lib/clinical-csv";
import { Button, Card, ErrorBox, SectionTitle } from "@/components/ui";

type AuditEntry = Record<string, unknown>;
type Item = {
  id: string;
  kind: string;
  outcome: string;
  resolved_at: string;
  events: AuditEntry[];
  slips: AuditEntry[];
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
  corrections: AuditEntry[];
  items: Item[];
};

export function AdminClinicalRecords({ initial, initialError = null }: { initial: ClinicalRecord[]; initialError?: string | null }) {
  const [records, setRecords] = useState(initial);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const supabase = createClient();

  async function refresh(includeArchived = showArchived) {
    const { data, error: rpcError } = await supabase.rpc("admin_clinical_records", {
      p_include_archived: includeArchived,
    });
    if (rpcError) setError("Clinical records could not be loaded.");
    else setRecords((data ?? []) as ClinicalRecord[]);
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

  async function reverse(item: Item) {
    const reason = window.prompt("Reason for reversing this later fulfilment:");
    if (!reason?.trim()) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("admin_reverse_fulfilment", {
      p_item_id: item.id,
      p_reason: reason.trim(),
    });
    if (rpcError) setError(rpcError.message || "Fulfilment could not be reversed.");
    else await refresh();
    setBusy(false);
  }

  function exportCsv() {
    const rows = [
      ["registration", "patient", "camp", "created_at", "archived_at", "effective_transcription", "corrections", "items_with_events_and_slips"],
      ...records.map((record) => [
        String(record.reg_no), record.patient_name, record.camp_name, record.created_at,
        record.archived_at ?? "", JSON.stringify(record.data), JSON.stringify(record.corrections),
        JSON.stringify(record.items),
      ]),
    ];
    const csv = rows.map((row) => row.map(encodeCsvCell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `clinical-records-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={exportCsv}>Export authorized CSV</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => {
          const next = !showArchived;
          setShowArchived(next);
          void refresh(next);
        }}>{showArchived ? "Hide archived" : "Include archived"}</Button>
      </div>
      <ErrorBox message={error} />
      {error ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void refresh()}>Retry loading records</Button> : null}
      {records.map((record) => (
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
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs">{JSON.stringify(record.data, null, 2)}</pre>
          <details className="rounded-xl border border-border p-3 text-sm">
            <summary className="cursor-pointer font-semibold">Correction audit ({record.corrections.length})</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(record.corrections, null, 2)}</pre>
          </details>
          <div className="space-y-2">
            {record.items.map((item) => (
              <div key={item.id} className="space-y-2 rounded-xl border border-border p-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span><strong>{item.kind.toUpperCase()}</strong> · {item.outcome.replaceAll("_", " ")}</span>
                  {item.outcome === "fulfilled" ? <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void reverse(item)}>Reverse later fulfilment</Button> : null}
                </div>
                <details>
                  <summary className="cursor-pointer font-semibold">Event and slip audit ({item.events.length + item.slips.length})</summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ events: item.events, slips: item.slips }, null, 2)}</pre>
                </details>
              </div>
            ))}
          </div>
        </Card>
      ))}
      {!records.length ? <Card><p className="text-sm text-muted">No clinical records in this view.</p></Card> : null}
    </div>
  );
}
