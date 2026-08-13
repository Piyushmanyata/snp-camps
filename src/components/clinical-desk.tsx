"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { parsePatientIdFromQr, parseRegistrationNumber } from "@/lib/qr";
import {
  DEFAULT_PRESCRIPTION_TEMPLATE,
  resolvePrescriptionTemplate,
} from "@/lib/prescription-template";
import {
  acquireDeskPrintTarget,
  type DeskPrintTarget,
} from "@/lib/desk-register-flow";
import {
  isSameTranscription,
  validateClinicalTranscription,
} from "@/lib/clinical-transcription-validate";
import {
  normalizeDiagnoses,
  validateUnavailableMedicines,
} from "@/lib/clinical-diagnoses";
import { showSuccessToast } from "@/lib/toast-bus";
import { useToastedError } from "@/lib/use-toasted-error";
import { Button, Card, Input, SectionTitle } from "@/components/ui";
import { ClinicalRecordView } from "@/components/clinical-record-view";

type Patient = {
  id: string;
  reg_no: number;
  full_name: string;
  age: number | null;
  gender: string | null;
  camp_id: string;
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

const KIND_HEADINGS: Record<keyof typeof OUTCOMES, string> = {
  medicine: "DAWAI",
  specs: "CHASHMA",
  ot: "OPERATION (OT)",
};

const OUTCOME_LABELS: Record<string, string> = {
  fulfilled: "De diya",
  not_available: "Available nahi",
  not_required: "Zaroorat nahi",
  deferred: "Baad mein milega",
};

const SAVE_FIRST = "Pehle record save karein, phir faisla likhein.";

type ResolveKind = keyof typeof KIND_HEADINGS;

const RESOLVE_ERRORS: Array<
  [RegExp, string | ((kind: ResolveKind) => string)]
> = [
  [
    /unavailable medicines/i,
    "Pehle unavailable dawaiyan likhein, phir Available nahi save karein.",
  ],
  [
    /medicine detail/i,
    "Pehle parchi ki dawaiyan likhein, phir faisla save karein.",
  ],
  [
    /Specs measurements/i,
    "Pehle chashme ka number bharein, phir faisla save karein.",
  ],
  [
    /OT detail/i,
    "Pehle OT ki aankh aur procedure likhein, phir faisla save karein.",
  ],
  [
    /date and venue/i,
    (kind) =>
      `Admin se is camp ke liye ${KIND_HEADINGS[kind]} collection date aur venue set karwayein, phir defer karein.`,
  ],
  [/seen transcription required/i, SAVE_FIRST],
  [
    /outcome conflict/i,
    "Is item ka pehle se alag faisla hai. Admin se reverse karwayein.",
  ],
  [
    /clinical operator only/i,
    "Sirf Clinical Desk Operator faisla save kar sakta hai.",
  ],
];

const NOT_FOUND_MESSAGE =
  "Yeh number kisi dekhe hue marij ka nahi mila. Number check karke dobara try karein.";

const BLOCKED_SLIP_SUFFIX =
  'Slip window browser ne rok di — "Slip kholein" link dabayen.';

type SlipReplaceState = {
  slip: { id: string; date: string; venue: string };
  date: string;
  venue: string;
  reason: string;
};

function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome.replaceAll("_", " ");
}

export function ClinicalDesk({
  canMutate = true,
  initialScan = null,
}: {
  /** When false (admin view), Save/Resolve/Replace controls are hidden. */
  canMutate?: boolean;
  /** Prefill from `/clinical?scan=` deep link. */
  initialScan?: string | null;
}) {
  const supabase = createClient();
  const [exact, setExact] = useState(initialScan ?? "");
  const [record, setRecord] = useState<Lookup | null>(null);
  const [followup, setFollowup] = useState<
    Array<{ id: string; kind: string; outcome: string; camp_name: string }>
  >([]);
  const [diagnosisOptions, setDiagnosisOptions] = useState(
    DEFAULT_PRESCRIPTION_TEMPLATE.diagnosisOptions,
  );
  const [diagnosisSelected, setDiagnosisSelected] = useState<string[]>([]);
  const [retiredDiagnoses, setRetiredDiagnoses] = useState<string[]>([]);
  const [diagnosisOther, setDiagnosisOther] = useState("");
  const [diagnosisOtherOriginal, setDiagnosisOtherOriginal] = useState<string[]>([]);
  const [diagnosisOtherEdited, setDiagnosisOtherEdited] = useState(false);
  const [medicineIntent, setMedicineIntent] = useState<string | null>(null);
  const [bloodSugar, setBloodSugar] = useState("");
  const [bloodPressure, setBloodPressure] = useState("");
  const [remarks, setRemarks] = useState("");
  const [medicines, setMedicines] = useState("");
  const [specType, setSpecType] = useState("");
  const [specRight, setSpecRight] = useState({
    sphere: "",
    cylinder: "",
    axis: "",
    vision: "",
    near: "",
  });
  const [specLeft, setSpecLeft] = useState({
    sphere: "",
    cylinder: "",
    axis: "",
    vision: "",
    near: "",
  });
  const [specPd, setSpecPd] = useState("");
  const [otEye, setOtEye] = useState("");
  const [otProcedure, setOtProcedure] = useState("");
  const [otNotes, setOtNotes] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useToastedError(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessageState] = useState<string | null>(null);
  const [slipReplace, setSlipReplace] = useState<SlipReplaceState | null>(null);
  const [lastSlipId, setLastSlipId] = useState<string | null>(null);
  const [unavailableMedicines, setUnavailableMedicines] = useState("");
  const slipReplaceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const slipReplaceDialogRef = useRef<HTMLDialogElement | null>(null);
  const lookupGenerationRef = useRef(0);
  const displayedPatientIdRef = useRef<string | null>(null);

  const setMessage = (next: string | null) => {
    setMessageState(next);
    if (next) showSuccessToast(next);
  };

  function isCurrentLookup(generation: number, patientId?: string | null) {
    return (
      lookupGenerationRef.current === generation &&
      (patientId == null || displayedPatientIdRef.current === patientId)
    );
  }

  function applySavedDiagnoses(saved: Record<string, unknown>, options = diagnosisOptions) {
    const normalized = normalizeDiagnoses(saved.diagnoses, options);
    const template = new Set(options);
    const retired = normalized.options.filter((option) => !template.has(option));
    setDiagnosisSelected(normalized.options);
    setRetiredDiagnoses(retired);
    setDiagnosisOther(normalized.other ?? "");
    setDiagnosisOtherOriginal(normalized.other ? [normalized.other] : []);
    setDiagnosisOtherEdited(false);
  }

  function clearRecordState() {
    displayedPatientIdRef.current = null;
    setRecord(null);
    setFollowup([]);
    setSlipReplace(null);
    setCorrectionReason("");
    setLastSlipId(null);
    setFieldErrors({});
    setUnavailableMedicines("");
    setMedicineIntent(null);
    setRetiredDiagnoses([]);
  }

  async function lookup(value = exact) {
    const generation = ++lookupGenerationRef.current;
    clearRecordState();
    setBusy(true);
    setError(null);
    setMessage(null);
    const patientId = parsePatientIdFromQr(value);
    const regNo = patientId ? null : parseRegistrationNumber(value);
    if (!patientId && !regNo) {
      setError("Patient QR scan karein ya sahi registration number likhein.");
      setBusy(false);
      return;
    }
    const { data, error: rpcError } = await supabase.rpc("clinical_lookup", {
      p_patient_id: patientId,
      p_reg_no: regNo,
    });
    if (!isCurrentLookup(generation)) return;
    if (rpcError) {
      if (/registration not found|not been seen/i.test(rpcError.message)) {
        const followupResult = await lookupFollowup(value);
        if (followupResult === "empty") {
          setError(NOT_FOUND_MESSAGE);
        }
      } else {
        setError("Registration lookup fail ho gaya. Dobara koshish karein.");
        setBusy(false);
      }
      return;
    }
    const next = data as Lookup;
    const nextPatientId = next.patient.id;
    const { data: templateData, error: templateError } = next.patient.camp_id
      ? await supabase.rpc("published_prescription_template", {
          p_camp_id: next.patient.camp_id,
        })
      : { data: null, error: null };
    if (!isCurrentLookup(generation)) return;
    const options = resolvePrescriptionTemplate(
      templateError ? null : templateData,
    ).diagnosisOptions;
    setDiagnosisOptions(options);
    displayedPatientIdRef.current = nextPatientId;
    setRecord(next);
    const saved = (next.effective_data ?? next.transcription?.data ?? {}) as Record<
      string,
      unknown
    >;
    applySavedDiagnoses(saved, options);
    setBloodSugar(String(saved.bloodSugar ?? ""));
    setBloodPressure(String(saved.bloodPressure ?? ""));
    setRemarks(String(saved.remarks ?? ""));
    setMedicines(String(saved.medicines ?? ""));
    const savedSpecs = (saved.specs ?? {}) as Record<string, unknown>;
    const right = (savedSpecs.right ?? {}) as Record<string, unknown>;
    const left = (savedSpecs.left ?? {}) as Record<string, unknown>;
    setSpecType(String(savedSpecs.type ?? ""));
    setSpecRight({
      sphere: String(right.sphere ?? ""),
      cylinder: String(right.cylinder ?? ""),
      axis: String(right.axis ?? ""),
      vision: String(right.vision ?? ""),
      near: String(right.near ?? ""),
    });
    setSpecLeft({
      sphere: String(left.sphere ?? ""),
      cylinder: String(left.cylinder ?? ""),
      axis: String(left.axis ?? ""),
      vision: String(left.vision ?? ""),
      near: String(left.near ?? ""),
    });
    setSpecPd(String(savedSpecs.pd ?? ""));
    const savedOt = (saved.ot ?? {}) as Record<string, unknown>;
    setOtEye(String(savedOt.eye ?? ""));
    setOtProcedure(String(savedOt.procedure ?? ""));
    setOtNotes(String(savedOt.notes ?? ""));
    setBusy(false);
  }

  useEffect(() => {
    if (!initialScan) return;
    // Defer so setState inside lookup is not synchronous in the effect body
    // (React Compiler set-state-in-effect); still one-shot for the deep link.
    const timer = setTimeout(() => {
      void lookup(initialScan);
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot deep link
  }, [initialScan]);

  useEffect(
    () => () => {
      lookupGenerationRef.current += 1;
    },
    [],
  );

  async function lookupFollowup(
    value = exact,
  ): Promise<"found" | "empty" | "error" | "stale"> {
    const generation = ++lookupGenerationRef.current;
    clearRecordState();
    setBusy(true);
    setError(null);
    const patientId = parsePatientIdFromQr(value);
    const regNo = patientId ? null : parseRegistrationNumber(value);
    if (!patientId && !regNo) {
      setError("Patient QR scan karein ya sahi registration number likhein.");
      setBusy(false);
      return "error";
    }
    const { data, error: rpcError } = await supabase.rpc("clinical_followup_lookup", {
      p_patient_id: patientId,
      p_reg_no: regNo,
    });
    if (!isCurrentLookup(generation)) return "stale";
    if (rpcError) {
      setError("Follow-up lookup fail ho gaya. Dobara koshish karein.");
      setBusy(false);
      return "error";
    }
    const items = (data ?? []) as typeof followup;
    setFollowup(items);
    setBusy(false);
    return items.length > 0 ? "found" : "empty";
  }

  async function fulfilFollowup(id: string) {
    if (!canMutate) return;
    const generation = lookupGenerationRef.current;
    setBusy(true);
    const { error: rpcError } = await supabase.rpc("clinical_followup_fulfil", {
      p_item_id: id,
    });
    if (!isCurrentLookup(generation)) return;
    if (rpcError) setError("Follow-up fulfilment conflicted with current state.");
    else {
      setMessage("Item pura ho gaya; purana record surakshit hai.");
      await lookupFollowup();
      return;
    }
    setBusy(false);
  }

  function transcriptionData() {
    const other = diagnosisOtherEdited
      ? diagnosisOther.trim() || null
      : diagnosisOtherOriginal.length
        ? diagnosisOtherOriginal.join("; ")
        : diagnosisOther.trim() || null;
    return {
      diagnoses: {
        options: diagnosisSelected,
        other,
      },
      bloodSugar: bloodSugar.trim() || null,
      bloodPressure: bloodPressure.trim() || null,
      remarks: remarks.trim() || null,
      medicines: medicines.trim() || null,
      specs: specType
        ? {
            type: specType,
            right: specRight,
            left: specLeft,
            pd: specPd.trim(),
          }
        : null,
      ot: otEye
        ? {
            eye: otEye,
            procedure: otProcedure.trim(),
            notes: otNotes.trim() || null,
          }
        : null,
    };
  }

  async function submitSlipReplace(printTarget: DeskPrintTarget | null = null) {
    if (!canMutate || !slipReplace) return;
    const { slip, date, venue, reason } = slipReplace;
    if (!date || !venue.trim() || !reason.trim()) {
      printTarget?.abandon();
      setError("Date, venue, and reason are required to replace a slip.");
      return;
    }
    const generation = lookupGenerationRef.current;
    const patientId = displayedPatientIdRef.current;
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc("clinical_replace_slip", {
      p_slip_id: slip.id,
      p_date: date,
      p_venue: venue.trim(),
      p_reason: reason.trim(),
    });
    if (!isCurrentLookup(generation, patientId)) return;
    if (rpcError) {
      printTarget?.abandon();
      setError("Slip badal nahi payi. Dobara koshish karein.");
    } else {
      const replacement = data as { id: string };
      closeSlipReplace();
      const navigated =
        printTarget?.navigate(`/clinical/slip/${replacement.id}`) ?? false;
      if (printTarget && !navigated) printTarget.abandon();
      setLastSlipId(replacement.id);
      setMessage(
        navigated ? "Nayi slip ban gayi." : `Nayi slip ban gayi. ${BLOCKED_SLIP_SUFFIX}`,
      );
      await lookup();
      return;
    }
    setBusy(false);
  }

  async function save() {
    if (!record || !canMutate) return;
    const data = transcriptionData();
    const validation = validateClinicalTranscription(data);
    if (!validation.ok) {
      setFieldErrors(
        Object.fromEntries(validation.errors.map((item) => [item.field, item.message])),
      );
      setError(validation.errors[0]?.message ?? "Enter valid clinical data.");
      return;
    }
    const patientId = record.patient.id;
    const generation = lookupGenerationRef.current;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const { error: rpcError } = await supabase.rpc("clinical_save_transcription", {
        p_patient_id: patientId,
        p_data: data,
      });
      if (rpcError) throw rpcError;
      if (!isCurrentLookup(generation, patientId)) return;
      setMessage("Record save ho gaya.");
      await lookup();
    } catch {
      if (isCurrentLookup(generation, patientId)) {
        setError("Could not save transcription. Try again.");
      }
    } finally {
      if (isCurrentLookup(generation, patientId)) setBusy(false);
    }
  }

  async function addCorrection() {
    if (!canMutate) return;
    if (!record || !correctionReason.trim()) {
      setError("Enter a correction reason.");
      return;
    }
    const data = transcriptionData();
    const validation = validateClinicalTranscription(data);
    if (!validation.ok) {
      setFieldErrors(
        Object.fromEntries(validation.errors.map((item) => [item.field, item.message])),
      );
      setError(validation.errors[0]?.message ?? "Enter valid clinical data.");
      return;
    }
    if (isSameTranscription(data, record.effective_data)) {
      setError("Change at least one field before appending a correction.");
      return;
    }
    const patientId = record.patient.id;
    const generation = lookupGenerationRef.current;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const { error: rpcError } = await supabase.rpc("clinical_add_correction", {
        p_patient_id: patientId,
        p_data: data,
        p_reason: correctionReason.trim(),
      });
      if (rpcError) throw rpcError;
      if (!isCurrentLookup(generation, patientId)) return;
      setCorrectionReason("");
      setMessage("Correction jud gaya; purana record surakshit hai.");
      await lookup();
    } catch {
      if (isCurrentLookup(generation, patientId)) {
        setError("Could not append correction. Try again.");
      }
    } finally {
      if (isCurrentLookup(generation, patientId)) setBusy(false);
    }
  }

  async function resolve(
    kind: keyof typeof OUTCOMES,
    outcome: string,
    printTarget: DeskPrintTarget | null = null,
  ) {
    if (!record || !canMutate) return;
    if (!record.transcription?.id) {
      setError(SAVE_FIRST);
      return;
    }
    let unavailableList: string[] | null = null;
    if (kind === "medicine" && outcome === "not_available") {
      const parsed = unavailableMedicines
        .split(/[\n,;]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      const validated = validateUnavailableMedicines(parsed);
      if (!validated.ok) {
        printTarget?.abandon();
        setError(validated.message);
        return;
      }
      unavailableList = validated.medicines;
    }
    const patientId = record.patient.id;
    const generation = lookupGenerationRef.current;
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc("clinical_resolve_item", {
      p_patient_id: patientId,
      p_kind: kind,
      p_outcome: outcome,
      p_unavailable_medicines: unavailableList,
    });
    if (!isCurrentLookup(generation, patientId)) return;
    if (rpcError) {
      printTarget?.abandon();
      const rpcMessage = rpcError.message;
      const matched = RESOLVE_ERRORS.find(([pattern]) => pattern.test(rpcMessage));
      const entry = matched?.[1];
      const mapped =
        typeof entry === "function"
          ? entry(kind)
          : (entry ?? "Faisla save nahi hua. Dobara koshish karein.");
      setError(mapped);
    } else {
      const slip = (data as { slip?: { id?: string } } | null)?.slip;
      const navigated =
        slip?.id && printTarget
          ? printTarget.navigate(`/clinical/slip/${slip.id}`)
          : false;
      if (printTarget && (!slip?.id || !navigated)) printTarget.abandon();
      const heading = KIND_HEADINGS[kind];
      const base = `${heading} ka faisla save ho gaya.`;
      if (slip?.id) {
        setLastSlipId(slip.id);
        setMessage(
          printTarget && !navigated ? `${base} ${BLOCKED_SLIP_SUFFIX}` : base,
        );
      } else {
        setMessage(base);
      }
      setMedicineIntent(null);
      setUnavailableMedicines("");
      await lookup();
      return;
    }
    setBusy(false);
  }

  function closeSlipReplace() {
    setSlipReplace(null);
    queueMicrotask(() => slipReplaceTriggerRef.current?.focus());
  }

  useEffect(() => {
    const dialog = slipReplaceDialogRef.current;
    if (!slipReplace) {
      if (dialog?.open) dialog.close();
      return;
    }
    if (dialog && !dialog.open) dialog.showModal();
    requestAnimationFrame(() => document.getElementById("slip-replace-date")?.focus());
  }, [slipReplace]);

  function toggleDiagnosis(option: string) {
    if (retiredDiagnoses.includes(option)) return;
    setDiagnosisSelected((current) =>
      current.includes(option)
        ? current.filter((item) => item !== option)
        : [...current, option],
    );
  }

  const hasTranscription = Boolean(record?.transcription?.id);
  const selectClass =
    "mt-1 min-h-12 w-full rounded-xl border border-border bg-white px-3 focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";

  return (
    <div className="space-y-5">
      {!canMutate ? (
        <p
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
        >
          Admin view — lookup and history only. Save, resolve, and slip replace are
          available to clinical operators.
        </p>
      ) : null}
      <Card className="space-y-3">
        <SectionTitle>Marij dhundein</SectionTitle>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void lookup();
          }}
        >
          <Input
            id="clinical-exact-lookup"
            label="Patient QR ya registration number"
            value={exact}
            onChange={(event) => {
              lookupGenerationRef.current += 1;
              setExact(event.target.value);
            }}
            placeholder="USB scanner se scan karein ya number type karein"
          />
          <Button type="submit" disabled={busy}>
            Dhundein
          </Button>
        </form>
      </Card>
      {error ? (
        <p role="alert" className="sr-only">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="rounded-xl bg-brand-soft p-3 text-sm font-semibold text-brand">
          {message}
          {lastSlipId ? (
            <a
              href={`/clinical/slip/${lastSlipId}`}
              target="_blank"
              rel="noopener"
              className="ml-2 text-brand font-semibold underline"
            >
              Slip kholein
            </a>
          ) : null}
        </p>
      ) : null}
      {record ? (
        <>
          <Card className="space-y-4">
            <div>
              <SectionTitle>
                #{record.patient.reg_no} · {record.patient.full_name}
              </SectionTitle>
              <p className="text-sm text-muted">
                {record.patient.age ?? "—"} years · {record.patient.gender ?? "—"}
              </p>
            </div>
            {canMutate && record.transcription?.locked_at ? (
              <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p>
                  Pehla record lock ho gaya hai. Neeche fields badlein aur reason ke
                  saath correction jodein — purana record surakshit rehta hai.
                </p>
                <Input
                  id="clinical-correction-reason"
                  label="Correction ka reason"
                  value={correctionReason}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                />
              </div>
            ) : null}

            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-foreground">Diagnosis</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {diagnosisOptions.map((option) => {
                  const checked = diagnosisSelected.includes(option);
                  return (
                    <label
                      key={option}
                      className="flex min-h-12 items-center gap-2 rounded-xl border border-border bg-white px-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canMutate}
                        onChange={() => toggleDiagnosis(option)}
                      />
                      {option}
                    </label>
                  );
                })}
                {retiredDiagnoses.map((option) => (
                  <label
                    key={`retired-${option}`}
                    className="flex min-h-12 items-center gap-2 rounded-xl border border-border bg-slate-50 px-3 text-sm text-muted"
                  >
                    <input type="checkbox" checked disabled readOnly />
                    {option} (retired)
                  </label>
                ))}
              </div>
              <Input
                id="clinical-diagnosis-other"
                label="Anya diagnosis (optional)"
                value={diagnosisOther}
                onChange={(e) => {
                  setDiagnosisOther(e.target.value);
                  setDiagnosisOtherEdited(true);
                }}
                disabled={!canMutate}
                hint="Free text — commas se alag nahi hoga"
                error={fieldErrors.diagnoses}
              />
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                id="clinical-sugar"
                label="Blood sugar (optional)"
                value={bloodSugar}
                onChange={(e) => setBloodSugar(e.target.value)}
                disabled={!canMutate}
                hint="mg/dL, 20–1000"
                error={fieldErrors.bloodSugar}
              />
              <Input
                id="clinical-bp"
                label="Blood pressure (optional)"
                value={bloodPressure}
                onChange={(e) => setBloodPressure(e.target.value)}
                disabled={!canMutate}
                hint="systolic/diastolic, e.g. 120/80"
                error={fieldErrors.bloodPressure}
              />
            </div>
            <Input
              id="clinical-remarks"
              label="Remarks / salaah"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              disabled={!canMutate}
              error={fieldErrors.remarks}
            />
            <Input
              id="clinical-medicines"
              label="Parchi ki dawaiyan"
              value={medicines}
              onChange={(e) => setMedicines(e.target.value)}
              disabled={!canMutate}
              error={fieldErrors.medicines}
            />
            <Card className="space-y-3">
              <SectionTitle>Chashme ka number (Specs)</SectionTitle>
              <label className="block text-sm font-semibold">
                Chashme ka type
                <select
                  className={selectClass}
                  value={specType}
                  disabled={!canMutate}
                  onChange={(event) => setSpecType(event.target.value)}
                >
                  <option value="">Not selected</option>
                  <option value="distance">Distance</option>
                  <option value="near">Near</option>
                  <option value="bifocal">Bifocal</option>
                  <option value="progressive">Progressive</option>
                  <option value="fixed_power">Fixed power</option>
                </select>
              </label>
              {(["right", "left"] as const).map((side) => {
                const eye = side === "right" ? specRight : specLeft;
                const update = side === "right" ? setSpecRight : setSpecLeft;
                return (
                  <div key={side} className="grid gap-2 sm:grid-cols-5">
                    {(["sphere", "cylinder", "axis", "vision", "near"] as const).map(
                      (field) => (
                        <Input
                          key={field}
                          id={`spec-${side}-${field}`}
                          label={`${side === "right" ? "RE" : "LE"} ${field === "near" ? "Near add (D)" : field}`}
                          value={eye[field]}
                          disabled={!canMutate}
                          error={fieldErrors[`specs.${side}.${field}`]}
                          onChange={(event) =>
                            update((current) => ({
                              ...current,
                              [field]: event.target.value,
                            }))
                          }
                        />
                      ),
                    )}
                  </div>
                );
              })}
              <Input
                id="spec-pd"
                label="Pupillary distance (PD)"
                value={specPd}
                disabled={!canMutate}
                onChange={(event) => setSpecPd(event.target.value)}
                hint="Required when a spectacle type is selected · 30–80 mm"
                error={fieldErrors["specs.pd"]}
              />
            </Card>
            <Card className="space-y-3">
              <SectionTitle>Operation (OT) detail</SectionTitle>
              <label className="block text-sm font-semibold">
                Aankh
                <select
                  className={selectClass}
                  value={otEye}
                  disabled={!canMutate}
                  onChange={(event) => setOtEye(event.target.value)}
                >
                  <option value="">Not selected</option>
                  <option value="right">Right</option>
                  <option value="left">Left</option>
                  <option value="both">Both</option>
                </select>
              </label>
              <Input
                id="ot-procedure"
                label="Diagnosis / procedure"
                value={otProcedure}
                disabled={!canMutate}
                onChange={(event) => setOtProcedure(event.target.value)}
                hint="Required when an OT eye is selected"
                error={fieldErrors["ot.procedure"]}
              />
              <Input
                id="ot-notes"
                label="OT notes"
                value={otNotes}
                disabled={!canMutate}
                onChange={(event) => setOtNotes(event.target.value)}
                error={fieldErrors["ot.notes"]}
              />
            </Card>
            {canMutate ? (
              <>
                <Button
                  type="button"
                  disabled={busy || Boolean(record.transcription?.locked_at)}
                  onClick={() => void save()}
                >
                  Record save karein
                </Button>
                {record.transcription?.locked_at ? (
                  <Button
                    type="button"
                    disabled={busy || !correctionReason.trim()}
                    onClick={() => void addCorrection()}
                  >
                    Correction jodein
                  </Button>
                ) : null}
              </>
            ) : null}
          </Card>
          <div className="grid gap-3 md:grid-cols-3">
            {(Object.keys(OUTCOMES) as Array<keyof typeof OUTCOMES>).map((kind) => {
              const current = record.items.find((item) => item.kind === kind);
              const medicineNotAvailableOpen =
                kind === "medicine" &&
                !current &&
                medicineIntent === "not_available";
              return (
                <Card key={kind} className="space-y-3">
                  <SectionTitle>{KIND_HEADINGS[kind]}</SectionTitle>
                  <p className="text-sm text-muted">
                    {current?.outcome
                      ? `Abhi tak: ${outcomeLabel(current.outcome)}`
                      : "Abhi tak: koi faisla nahi"}
                  </p>
                  {canMutate && medicineNotAvailableOpen ? (
                    <div className="space-y-3">
                      <label
                        htmlFor="unavailable-medicines"
                        className="block text-sm font-semibold"
                      >
                        Kaunsi dawaiyan available nahi thin?
                        <textarea
                          id="unavailable-medicines"
                          className="mt-1 min-h-24 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                          value={unavailableMedicines}
                          onChange={(event) =>
                            setUnavailableMedicines(event.target.value)
                          }
                          placeholder="One medicine per line or separated by commas"
                        />
                      </label>
                      <Button
                        type="button"
                        disabled={busy || !hasTranscription}
                        onClick={() => void resolve("medicine", "not_available")}
                      >
                        Save karein: dawai available nahi
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          setMedicineIntent(null);
                          setUnavailableMedicines("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : null}
                  {canMutate && !medicineNotAvailableOpen
                    ? OUTCOMES[kind].map((outcome) => (
                        <Button
                          key={outcome}
                          type="button"
                          variant="secondary"
                          disabled={busy || Boolean(current) || !hasTranscription}
                          onClick={() => {
                            if (kind === "medicine" && outcome === "not_available") {
                              setMedicineIntent("not_available");
                              return;
                            }
                            if (kind === "medicine") {
                              setMedicineIntent(null);
                            }
                            const printTarget =
                              outcome === "deferred"
                                ? acquireDeskPrintTarget((url, target, features) =>
                                    window.open(url, target, features),
                                  )
                                : null;
                            void resolve(kind, outcome, printTarget);
                          }}
                        >
                          {outcomeLabel(outcome)}
                        </Button>
                      ))
                    : null}
                  {!hasTranscription && canMutate ? (
                    <p className="text-xs text-muted">{SAVE_FIRST}</p>
                  ) : null}
                  {current?.slip ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          window.open(`/clinical/slip/${current.slip!.id}`, "_blank")
                        }
                      >
                        Slip dobara print karein
                      </Button>
                      {canMutate ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={(event) => {
                            slipReplaceTriggerRef.current = event.currentTarget;
                            setSlipReplace({
                              slip: current.slip!,
                              date: current.slip!.date,
                              venue: current.slip!.venue,
                              reason: "",
                            });
                          }}
                        >
                          Slip badlein
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </div>
          {record.history.length ? (
            <Card className="space-y-3">
              <SectionTitle>Pichhle camps ka record · sirf padhne ke liye</SectionTitle>
              {record.history.map((entry) => (
                <div
                  key={`${entry.camp_id}-${entry.created_at}`}
                  className="rounded-xl border border-border p-3"
                >
                  <p className="text-sm font-semibold">
                    {entry.camp_name} ·{" "}
                    {new Date(entry.created_at).toLocaleDateString("en-IN")}
                  </p>
                  <ClinicalRecordView data={entry.data} />
                  <p className="mt-2 text-xs text-muted">
                    {entry.items.length
                      ? entry.items
                          .map(
                            (item) =>
                              `${item.kind}: ${outcomeLabel(item.outcome)}`,
                          )
                          .join(" · ")
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
                <p
                  key={`${correction.created_at}-${correction.reason}`}
                  className="text-sm text-muted"
                >
                  {new Date(correction.created_at).toLocaleString("en-IN")} ·{" "}
                  {correction.reason}
                </p>
              ))}
            </Card>
          ) : null}
        </>
      ) : null}
      {followup.length ? (
        <Card className="space-y-3">
          <SectionTitle>Purane camp ke baaki kaam</SectionTitle>
          {followup.map((item) => (
            <div
              key={item.id}
              className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <p className="text-sm">
                <strong>{KIND_HEADINGS[item.kind as keyof typeof OUTCOMES] ?? item.kind.toUpperCase()}</strong>{" "}
                · {outcomeLabel(item.outcome)} · {item.camp_name}
              </p>
              {canMutate ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void fulfilFollowup(item.id)}
                >
                  De diya — pura karein
                </Button>
              ) : null}
            </div>
          ))}
        </Card>
      ) : null}

      {slipReplace ? (
        <dialog
          ref={slipReplaceDialogRef}
          aria-modal="true"
          aria-labelledby="slip-replace-title"
          className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/40"
          onCancel={(event) => {
            event.preventDefault();
            closeSlipReplace();
          }}
        >
          <Card className="w-full max-w-md space-y-3">
            <SectionTitle>
              <span id="slip-replace-title">Deferred slip badlein</span>
            </SectionTitle>
            <Input
              id="slip-replace-date"
              label="Nayi date"
              type="date"
              value={slipReplace.date}
              onChange={(e) =>
                setSlipReplace((current) =>
                  current ? { ...current, date: e.target.value } : current,
                )
              }
            />
            <Input
              id="slip-replace-venue"
              label="Nayi jagah (venue)"
              value={slipReplace.venue}
              onChange={(e) =>
                setSlipReplace((current) =>
                  current ? { ...current, venue: e.target.value } : current,
                )
              }
            />
            <Input
              id="slip-replace-reason"
              label="Badalne ka reason"
              value={slipReplace.reason}
              onChange={(e) =>
                setSlipReplace((current) =>
                  current ? { ...current, reason: e.target.value } : current,
                )
              }
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void submitSlipReplace(
                    acquireDeskPrintTarget((url, target, features) =>
                      window.open(url, target, features),
                    ),
                  )
                }
              >
                Save replacement
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={closeSlipReplace}
              >
                Cancel
              </Button>
            </div>
          </Card>
        </dialog>
      ) : null}
    </div>
  );
}
