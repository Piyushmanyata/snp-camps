"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { parsePatientIdFromQr, parseRegistrationNumber } from "@/lib/qr";
import { Button, Card, ErrorBox, Input, SectionTitle } from "@/components/ui";
import { PatientQrCamera } from "@/components/patient-qr-camera";

type Patient = {
  id: string;
  reg_no: number;
  full_name: string;
  age: number | null;
  gender: string | null;
};
type Lookup = {
  patient: Patient;
  transcription: { id: string; data: Record<string, unknown>; locked_at: string | null } | null;
  effective_data: Record<string, unknown> | null;
  corrections: Array<{ reason: string; created_at: string }>;
  items: Array<{
    id: string;
    kind: string;
    outcome: string;
    slip?: { id: string; date: string; venue: string } | null;
  }>;
  history: Array<{
    camp_id: string;
    camp_name: string;
    created_at: string;
    data: Record<string, unknown>;
    items: Array<{ kind: string; outcome: string; resolved_at: string }>;
  }>;
};

const OUTCOMES = {
  medicine: ["fulfilled", "not_available", "not_required"],
  specs: ["fulfilled", "deferred", "not_required"],
  ot: ["fulfilled", "deferred", "not_required"],
} as const;

export function ClinicalDesk() {
  const supabase = createClient();
  const [exact, setExact] = useState("");
  const [record, setRecord] = useState<Lookup | null>(null);
  const [followup, setFollowup] = useState<Array<{ id: string; kind: string; outcome: string; camp_name: string }>>([]);
  const [diagnoses, setDiagnoses] = useState("");
  const [bloodSugar, setBloodSugar] = useState("");
  const [bloodPressure, setBloodPressure] = useState("");
  const [remarks, setRemarks] = useState("");
  const [medicines, setMedicines] = useState("");
  const [specType, setSpecType] = useState("");
  const [specRight, setSpecRight] = useState({ sphere: "", cylinder: "", axis: "", vision: "", near: "" });
  const [specLeft, setSpecLeft] = useState({ sphere: "", cylinder: "", axis: "", vision: "", near: "" });
  const [specPd, setSpecPd] = useState("");
  const [otEye, setOtEye] = useState("");
  const [otProcedure, setOtProcedure] = useState("");
  const [otNotes, setOtNotes] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function lookup(value = exact) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const patientId = parsePatientIdFromQr(value);
    const regNo = patientId ? null : parseRegistrationNumber(value);
    if (!patientId && !regNo) {
      setError("Scan a Patient QR or enter the exact registration number.");
      setBusy(false);
      return;
    }
    const { data, error: rpcError } = await supabase.rpc("clinical_lookup", {
      p_patient_id: patientId,
      p_reg_no: regNo,
    });
    if (rpcError) {
      setError(
        /not been seen/i.test(rpcError.message)
          ? "This registration has not reached Seen. No clinical record was opened."
          : "Exact registration lookup failed.",
      );
      setBusy(false);
      return;
    }
    const next = data as Lookup;
    setRecord(next);
    const saved = next.effective_data ?? next.transcription?.data ?? {};
    setDiagnoses(String(saved.diagnoses ?? ""));
    setBloodSugar(String(saved.bloodSugar ?? ""));
    setBloodPressure(String(saved.bloodPressure ?? ""));
    setRemarks(String(saved.remarks ?? ""));
    setMedicines(String(saved.medicines ?? ""));
    const savedSpecs = (saved.specs ?? {}) as Record<string, unknown>;
    const right = (savedSpecs.right ?? {}) as Record<string, unknown>;
    const left = (savedSpecs.left ?? {}) as Record<string, unknown>;
    setSpecType(String(savedSpecs.type ?? ""));
    setSpecRight({ sphere: String(right.sphere ?? ""), cylinder: String(right.cylinder ?? ""), axis: String(right.axis ?? ""), vision: String(right.vision ?? ""), near: String(right.near ?? "") });
    setSpecLeft({ sphere: String(left.sphere ?? ""), cylinder: String(left.cylinder ?? ""), axis: String(left.axis ?? ""), vision: String(left.vision ?? ""), near: String(left.near ?? "") });
    setSpecPd(String(savedSpecs.pd ?? ""));
    const savedOt = (saved.ot ?? {}) as Record<string, unknown>;
    setOtEye(String(savedOt.eye ?? ""));
    setOtProcedure(String(savedOt.procedure ?? ""));
    setOtNotes(String(savedOt.notes ?? ""));
    setBusy(false);
  }

  async function lookupFollowup() {
    setBusy(true);
    setError(null);
    const patientId = parsePatientIdFromQr(exact);
    const regNo = patientId ? null : parseRegistrationNumber(exact);
    if (!patientId && !regNo) {
      setError("Scan a Patient QR or enter the exact registration number.");
      setBusy(false);
      return;
    }
    const { data, error: rpcError } = await supabase.rpc("clinical_followup_lookup", {
      p_patient_id: patientId,
      p_reg_no: regNo,
    });
    if (rpcError) setError("Follow-up lookup failed.");
    else setFollowup((data ?? []) as typeof followup);
    setBusy(false);
  }

  async function fulfilFollowup(id: string) {
    setBusy(true);
    const { error: rpcError } = await supabase.rpc("clinical_followup_fulfil", {
      p_item_id: id,
    });
    if (rpcError) setError("Follow-up fulfilment conflicted with current state.");
    else {
      setMessage("Follow-up item fulfilled; original history preserved.");
      await lookupFollowup();
    }
    setBusy(false);
  }

  function transcriptionData() {
    return {
      diagnoses: diagnoses.split(",").map((v) => v.trim()).filter(Boolean),
      bloodSugar: bloodSugar.trim() || null,
      bloodPressure: bloodPressure.trim() || null,
      remarks: remarks.trim() || null,
      medicines: medicines.trim() || null,
      specs: specType ? {
        type: specType,
        right: specRight,
        left: specLeft,
        pd: specPd.trim(),
      } : null,
      ot: otEye ? {
        eye: otEye,
        procedure: otProcedure.trim(),
        notes: otNotes.trim() || null,
      } : null,
    };
  }

  async function replaceSlip(slip: { id: string; date: string; venue: string }) {
    const date = window.prompt("Replacement date (YYYY-MM-DD):", slip.date);
    const venue = window.prompt("Replacement venue:", slip.venue);
    const reason = window.prompt("Reason for replacing this slip:");
    if (!date || !venue?.trim() || !reason?.trim()) return;
    setBusy(true);
    const { data, error: rpcError } = await supabase.rpc("clinical_replace_slip", {
      p_slip_id: slip.id,
      p_date: date,
      p_venue: venue.trim(),
      p_reason: reason.trim(),
    });
    if (rpcError) setError(rpcError.message || "Slip could not be replaced.");
    else {
      const replacement = data as { id: string };
      window.open(`/clinical/slip/${replacement.id}`, "_blank");
      await lookup();
    }
    setBusy(false);
  }

  async function save() {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc("clinical_save_transcription", {
        p_patient_id: record.patient.id,
        p_data: transcriptionData(),
      });
      if (rpcError) throw rpcError;
      setMessage("Operational transcription saved from paper.");
      await lookup();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save transcription.");
    } finally {
      setBusy(false);
    }
  }

  async function addCorrection() {
    if (!record || !correctionReason.trim()) {
      setError("Enter a correction reason.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc("clinical_add_correction", {
        p_patient_id: record.patient.id,
        p_data: transcriptionData(),
        p_reason: correctionReason.trim(),
      });
      if (rpcError) throw rpcError;
      setCorrectionReason("");
      setMessage("Reasoned correction appended; original record preserved.");
      await lookup();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not append correction.");
    } finally {
      setBusy(false);
    }
  }

  async function resolve(kind: keyof typeof OUTCOMES, outcome: string) {
    if (!record) return;
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc("clinical_resolve_item", {
      p_patient_id: record.patient.id,
      p_kind: kind,
      p_outcome: outcome,
    });
    if (rpcError) {
      setError(
        /date and venue/i.test(rpcError.message)
          ? `Configure the matching ${kind.toUpperCase()} date and venue before deferring.`
          : "Outcome conflicted with an existing decision.",
      );
    } else {
      const slip = (data as { slip?: { id?: string } } | null)?.slip;
      setMessage(`${kind.toUpperCase()} saved.`);
      if (slip?.id) window.open(`/clinical/slip/${slip.id}`, "_blank");
      await lookup();
    }
    setBusy(false);
  }

  return (
    <div className="space-y-5">
      <Card className="space-y-3">
        <SectionTitle>Exact patient lookup</SectionTitle>
        <Input
          id="clinical-exact-lookup"
          label="Patient QR or registration number"
          value={exact}
          onChange={(event) => setExact(event.target.value)}
          placeholder="Scan QR or type exact number"
        />
        <PatientQrCamera
          onScan={(raw) => {
            setExact(raw);
            void lookup(raw);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy} onClick={() => void lookup()}>
            Open seen registration
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void lookupFollowup()}>
            Find unresolved follow-up
          </Button>
        </div>
      </Card>
      <ErrorBox message={error} />
      {message ? <p role="status" className="rounded-xl bg-brand-soft p-3 text-sm font-semibold text-brand">{message}</p> : null}
      {record ? (
        <>
          <Card className="space-y-4">
            <div>
              <SectionTitle>#{record.patient.reg_no} · {record.patient.full_name}</SectionTitle>
              <p className="text-sm text-muted">{record.patient.age ?? "—"} years · {record.patient.gender ?? "—"}</p>
            </div>
            {record.transcription?.locked_at ? (
              <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p>Original locked after the first outcome. Later changes are appended as corrections.</p>
                <Input id="clinical-correction-reason" label="Correction reason" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} />
              </div>
            ) : null}
            <Input id="clinical-diagnoses" label="Diagnosis options / Other" value={diagnoses} onChange={(e) => setDiagnoses(e.target.value)} hint="Comma-separated" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input id="clinical-sugar" label="Blood sugar (optional)" value={bloodSugar} onChange={(e) => setBloodSugar(e.target.value)} />
              <Input id="clinical-bp" label="Blood pressure (optional)" value={bloodPressure} onChange={(e) => setBloodPressure(e.target.value)} />
            </div>
            <Input id="clinical-remarks" label="Remarks / advice" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            <Input id="clinical-medicines" label="Medicines from paper" value={medicines} onChange={(e) => setMedicines(e.target.value)} />
            <Card className="space-y-3">
              <SectionTitle>Specs measurements</SectionTitle>
              <label className="block text-sm font-semibold">Approved type
                <select className="mt-1 min-h-12 w-full rounded-xl border border-border bg-white px-3" value={specType} onChange={(event) => setSpecType(event.target.value)}>
                  <option value="">Not selected</option>
                  <option value="distance">Distance</option><option value="near">Near</option>
                  <option value="bifocal">Bifocal</option><option value="progressive">Progressive</option>
                  <option value="fixed_power">Fixed power</option>
                </select>
              </label>
              {(["right", "left"] as const).map((side) => {
                const eye = side === "right" ? specRight : specLeft;
                const update = side === "right" ? setSpecRight : setSpecLeft;
                return <div key={side} className="grid gap-2 sm:grid-cols-5">
                  {(["sphere", "cylinder", "axis", "vision", "near"] as const).map((field) => (
                    <Input key={field} id={`spec-${side}-${field}`} label={`${side === "right" ? "RE" : "LE"} ${field}`} value={eye[field]} onChange={(event) => update((current) => ({ ...current, [field]: event.target.value }))} />
                  ))}
                </div>;
              })}
              <Input id="spec-pd" label="Pupillary distance (PD)" value={specPd} onChange={(event) => setSpecPd(event.target.value)} />
            </Card>
            <Card className="space-y-3">
              <SectionTitle>OT detail</SectionTitle>
              <label className="block text-sm font-semibold">Eye
                <select className="mt-1 min-h-12 w-full rounded-xl border border-border bg-white px-3" value={otEye} onChange={(event) => setOtEye(event.target.value)}>
                  <option value="">Not selected</option><option value="right">Right</option>
                  <option value="left">Left</option><option value="both">Both</option>
                </select>
              </label>
              <Input id="ot-procedure" label="Diagnosis / procedure" value={otProcedure} onChange={(event) => setOtProcedure(event.target.value)} />
              <Input id="ot-notes" label="OT notes" value={otNotes} onChange={(event) => setOtNotes(event.target.value)} />
            </Card>
            <Button type="button" disabled={busy || Boolean(record.transcription?.locked_at)} onClick={() => void save()}>
              Save transcription
            </Button>
            {record.transcription?.locked_at ? (
              <Button type="button" disabled={busy || !correctionReason.trim()} onClick={() => void addCorrection()}>
                Append correction
              </Button>
            ) : null}
          </Card>
          <div className="grid gap-3 md:grid-cols-3">
            {(Object.keys(OUTCOMES) as Array<keyof typeof OUTCOMES>).map((kind) => {
              const current = record.items.find((item) => item.kind === kind);
              return (
                <Card key={kind} className="space-y-3">
                  <SectionTitle>{kind.toUpperCase()}</SectionTitle>
                  <p className="text-sm text-muted">Current: {current?.outcome ?? "unresolved"}</p>
                  {OUTCOMES[kind].map((outcome) => (
                    <Button key={outcome} type="button" variant="secondary" disabled={busy || Boolean(current)} onClick={() => void resolve(kind, outcome)}>
                      {outcome.replace("_", " ")}
                    </Button>
                  ))}
                  {current?.slip ? (
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="secondary" onClick={() => window.open(`/clinical/slip/${current.slip!.id}`, "_blank")}>Reprint active slip</Button>
                      <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void replaceSlip(current.slip!)}>Replace slip</Button>
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </div>
          {record.history.length ? (
            <Card className="space-y-3">
              <SectionTitle>Prior clinical history · read-only</SectionTitle>
              {record.history.map((entry) => (
                <div key={`${entry.camp_id}-${entry.created_at}`} className="rounded-xl border border-border p-3">
                  <p className="text-sm font-semibold">{entry.camp_name} · {new Date(entry.created_at).toLocaleDateString("en-IN")}</p>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs">{JSON.stringify(entry.data, null, 2)}</pre>
                  <p className="mt-2 text-xs text-muted">
                    {entry.items.length
                      ? entry.items.map((item) => `${item.kind}: ${item.outcome.replaceAll("_", " ")}`).join(" · ")
                      : "No fulfilment outcomes recorded."}
                  </p>
                </div>
              ))}
            </Card>
          ) : null}
          {record.corrections.length ? (
            <Card className="space-y-2">
              <SectionTitle>Correction audit</SectionTitle>
              {record.corrections.map((correction) => (
                <p key={`${correction.created_at}-${correction.reason}`} className="text-sm text-muted">
                  {new Date(correction.created_at).toLocaleString("en-IN")} · {correction.reason}
                </p>
              ))}
            </Card>
          ) : null}
        </>
      ) : null}
      {followup.length ? (
        <Card className="space-y-3">
          <SectionTitle>Unresolved historical items</SectionTitle>
          {followup.map((item) => (
            <div key={item.id} className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm"><strong>{item.kind.toUpperCase()}</strong> · {item.outcome.replace("_", " ")} · {item.camp_name}</p>
              <Button type="button" size="sm" disabled={busy} onClick={() => void fulfilFollowup(item.id)}>Mark fulfilled</Button>
            </div>
          ))}
        </Card>
      ) : null}
    </div>
  );
}
