"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { isSameTranscription } from "@/lib/clinical-transcription-validate";
import {
  normalizeDiagnoses,
  validateUnavailableMedicines,
} from "@/lib/clinical-diagnoses";
import { logDbError } from "@/lib/public-error";
import { showSuccessToast } from "@/lib/toast-bus";
import { genderLabel } from "@/lib/types";
import { useToastedError } from "@/lib/use-toasted-error";
import { Button, Card, Input, SectionTitle } from "@/components/ui";
import { ClinicalRecordView } from "@/components/clinical-record-view";
import {
  CLINICAL_LINES,
  CLINICAL_LINE_LABELS,
  lineDecisions,
  lineKind,
  otherSpecsLine,
  type ClinicalLine,
} from "@/lib/clinical-line-map";
import { needsOtScheduleDay, pickEarliestFreeOtDay } from "@/lib/ot-day-select";
import { formatCampDay } from "@/lib/format-camp-day";

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
  medicine: "MEDICINES",
  specs: "SPECTACLES",
  ot: "SURGERY (OT)",
};

const OUTCOME_LABELS: Record<string, string> = {
  fulfilled: "Dispensed",
  not_available: "Not available",
  not_required: "Not required",
  deferred: "Deferred",
};

const SAVE_FIRST = "Save record first before recording outcome.";

type ResolveKind = keyof typeof KIND_HEADINGS;

const CLINICAL_ERRORS: Array<
  [RegExp, string | ((kind: ResolveKind, line?: ClinicalLine) => string)]
> = [
  [
    /diagnos/i,
    "Select at least 1 diagnosis (maximum 12).",
  ],
  [
    /blood sugar/i,
    "Blood sugar must be between 20 and 1000 mg/dL.",
  ],
  [
    /blood pressure/i,
    "Enter blood pressure as systolic/diastolic, e.g. 120/80.",
  ],
  [
    /\bpd\b|pupillary/i,
    "PD must be between 30 and 80 mm.",
  ],
  [
    /sphere|cylinder|axis|spectacle|specs type/i,
    "Enter complete spectacle measurements within valid range.",
  ],
  [
    /ot (eye|procedure)|procedure/i,
    "Enter surgery eye and procedure.",
  ],
  [
    /locked|lock/i,
    "This record is locked. Add a correction with a reason.",
  ],
  [
    /reason/i,
    "Enter a reason for the correction.",
  ],
  [
    /too large|32768|payload/i,
    "Record is too large. Shorten remarks and medicine details.",
  ],
  [
    /unavailable medicines/i,
    "Enter unavailable medicines before saving as Not Available.",
  ],
  [
    /medicine detail/i,
    "Enter prescription medicines before saving outcome.",
  ],
  [
    /Specs measurements/i,
    "Enter spectacle measurements before saving outcome.",
  ],
  [
    /OT detail/i,
    "Enter surgery eye and procedure before saving outcome.",
  ],
  [
    /date and venue/i,
    (kind) =>
      `Ask admin to set collection date and venue for ${KIND_HEADINGS[kind]}, then defer.`,
  ],
  [/seen transcription required/i, SAVE_FIRST],
  [
    /outcome conflict/i,
    (kind, line) => {
      const other = kind === "specs" && line ? otherSpecsLine(line) : null;
      return other
        ? `The ${CLINICAL_LINE_LABELS[other]} station already recorded an outcome. Ask an admin to reverse it.`
        : "An outcome is already recorded for this item. Ask an admin to reverse it.";
    },
  ],
  [
    /clinical operator only/i,
    "Only Clinical Desk Operators can record outcomes.",
  ],
  [
    /OT_SCHEDULE_FULL/i,
    "All surgery dates are full — ask admin to add a new date.",
  ],
];

const CLINICAL_REFUSAL_FALLBACK =
  "Could not complete this action. Please try again or ask an admin.";

function clinicalRefusal(
  message: string | null | undefined,
  kind?: ResolveKind,
  line?: ClinicalLine,
): string {
  const text = message?.trim();
  if (!text) {
    return "Network issue. Check your connection and try again.";
  }
  const matched = CLINICAL_ERRORS.find(([pattern]) => pattern.test(text));
  const entry = matched?.[1];
  if (typeof entry === "function") {
    return kind ? entry(kind, line) : CLINICAL_REFUSAL_FALLBACK;
  }
  if (entry) return entry;
  logDbError(text, "clinical-desk.refusal");
  return CLINICAL_REFUSAL_FALLBACK;
}

const NOT_FOUND_MESSAGE =
  "No seen patient found with this number. Check the number and try again.";

const BLOCKED_SLIP_SUFFIX =
  'Slip window was blocked by browser — click the "Open slip" link.';

type SlipReplaceState = {
  slip: { id: string; date: string; venue: string };
  date: string;
  venue: string;
  reason: string;
};

function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome.replaceAll("_", " ");
}

const CLINICAL_LINE_KEY = "clinical-line";
const DEFAULT_CLINICAL_LINE: ClinicalLine = "medicine";
const clinicalLineListeners = new Set<() => void>();

function subscribeClinicalLine(onChange: () => void): () => void {
  clinicalLineListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    clinicalLineListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readClinicalLine(): ClinicalLine {
  const stored = window.localStorage.getItem(CLINICAL_LINE_KEY);
  return CLINICAL_LINES.includes(stored as ClinicalLine)
    ? (stored as ClinicalLine)
    : DEFAULT_CLINICAL_LINE;
}

function writeClinicalLine(next: ClinicalLine): void {
  window.localStorage.setItem(CLINICAL_LINE_KEY, next);
  for (const listener of clinicalLineListeners) listener();
}

export function ClinicalDesk({
  canMutate = true,
  initialScan = null,
}: {
  canMutate?: boolean;
  initialScan?: string | null;
}) {
  const supabase = createClient();
  const line = useSyncExternalStore(
    subscribeClinicalLine,
    readClinicalLine,
    () => DEFAULT_CLINICAL_LINE,
  );
  const setLine = writeClinicalLine;
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
  const [otDaysFailed, setOtDaysFailed] = useState(false);
  const [otDays, setOtDays] = useState<
    Array<{
      id: string;
      dayDate: string;
      venue: string;
      seatLimit: number;
      seatsTaken: number;
    }>
  >([]);
  const [otDayId, setOtDayId] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useToastedError(null);
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
      setError("Scan patient QR or enter a valid registration number.");
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
        setError("Registration lookup failed. Please try again.");
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
    await loadOtDays(next.patient.camp_id);
    setBusy(false);
  }

  async function loadOtDays(campId: string) {
    const { data, error: listError } = await supabase.rpc(
      "list_ot_schedule_days",
      { p_camp_id: campId },
    );
    if (listError || !data) {
      setOtDays([]);
      setOtDayId("");
      setOtDaysFailed(true);
      return;
    }
    setOtDaysFailed(false);
    const rows = (
      data as Array<{
        id: string;
        day_date: string;
        venue: string;
        seat_limit: number;
        seats_taken: number;
      }>
    ).map((row) => ({
      id: row.id,
      dayDate: String(row.day_date).slice(0, 10),
      venue: row.venue,
      seatLimit: Number(row.seat_limit),
      seatsTaken: Number(row.seats_taken),
    }));
    setOtDays(rows);
    const picked = pickEarliestFreeOtDay(rows);
    setOtDayId(picked?.id ?? "");
  }

  useEffect(() => {
    if (!initialScan) return;
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
      setError("Scan patient QR or enter a valid registration number.");
      setBusy(false);
      return "error";
    }
    const { data, error: rpcError } = await supabase.rpc("clinical_followup_lookup", {
      p_patient_id: patientId,
      p_reg_no: regNo,
    });
    if (!isCurrentLookup(generation)) return "stale";
    if (rpcError) {
      setError("Follow-up lookup failed. Please try again.");
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
    if (rpcError) setError("Follow-up does not match current record. Please reopen patient.");
    else {
      setMessage("Item fulfilled; existing record preserved.");
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
      setError("Date, venue, and reason are all required to replace a slip.");
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
      setError("Could not replace slip. Please try again.");
    } else {
      const replacement = data as { id: string };
      closeSlipReplace();
      const navigated =
        printTarget?.navigate(`/clinical/slip/${replacement.id}`) ?? false;
      if (printTarget && !navigated) printTarget.abandon();
      setLastSlipId(replacement.id);
      setMessage(
        navigated ? "New slip created." : `New slip created. ${BLOCKED_SLIP_SUFFIX}`,
      );
      await lookup();
      return;
    }
    setBusy(false);
  }

  async function save() {
    if (!record || !canMutate) return;
    const data = transcriptionData();
    const patientId = record.patient.id;
    const generation = lookupGenerationRef.current;
    setBusy(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc("clinical_save_transcription", {
        p_patient_id: patientId,
        p_data: data,
      });
      if (rpcError) throw rpcError;
      if (!isCurrentLookup(generation, patientId)) return;
      setMessage("Record saved.");
      await lookup();
    } catch (thrown) {
      if (isCurrentLookup(generation, patientId)) {
        setError(
          clinicalRefusal(
            thrown instanceof Error ? thrown.message : null,
          ),
        );
      }
    } finally {
      if (isCurrentLookup(generation, patientId)) setBusy(false);
    }
  }

  async function addCorrection() {
    if (!canMutate) return;
    if (!record || !correctionReason.trim()) {
      setError("Please provide a reason for correction.");
      return;
    }
    const data = transcriptionData();
    if (isSameTranscription(data, record.effective_data)) {
      setError("Change a field first before adding a correction.");
      return;
    }
    const patientId = record.patient.id;
    const generation = lookupGenerationRef.current;
    setBusy(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc("clinical_add_correction", {
        p_patient_id: patientId,
        p_data: data,
        p_reason: correctionReason.trim(),
      });
      if (rpcError) throw rpcError;
      if (!isCurrentLookup(generation, patientId)) return;
      setCorrectionReason("");
      setMessage("Correction added; existing record preserved.");
      await lookup();
    } catch (thrown) {
      if (isCurrentLookup(generation, patientId)) {
        setError(
          clinicalRefusal(
            thrown instanceof Error ? thrown.message : null,
          ),
        );
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
    if (needsOtScheduleDay(kind, outcome, otDayId)) {
      printTarget?.abandon();
      setError(
        otDaysFailed
          ? "OT dates failed to load. Please reopen patient."
          : "All surgery dates are full — ask admin to add a new date.",
      );
      return;
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
      ...(kind === "ot" && outcome === "deferred"
        ? { p_ot_schedule_day_id: otDayId }
        : {}),
    });
    if (!isCurrentLookup(generation, patientId)) return;
    if (rpcError) {
      printTarget?.abandon();
      setError(clinicalRefusal(rpcError.message, kind, line));
    } else {
      const slip = (data as { slip?: { id?: string } } | null)?.slip;
      const navigated =
        slip?.id && printTarget
          ? printTarget.navigate(`/clinical/slip/${slip.id}`)
          : false;
      if (printTarget && (!slip?.id || !navigated)) printTarget.abandon();
      const heading = KIND_HEADINGS[kind];
      const base = `${heading} decision saved.`;
      if (slip?.id) {
        setLastSlipId(slip.id);
        void fetch("/api/notify/deferral", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slipId: slip.id }),
        });
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
    if (retiredDiagnoses.includes(option) || record?.transcription?.id) return;
    setDiagnosisSelected((current) =>
      current.includes(option)
        ? current.filter((item) => item !== option)
        : [...current, option],
    );
  }

  const hasTranscription = Boolean(record?.transcription?.id);
  const kind = lineKind(line);
  const fields = canMutate
    ? {
        medicines: kind === "medicine",
        specs: kind === "specs",
        ot: kind === "ot",
      }
    : { medicines: true, specs: true, ot: true };
  const openOtDays = otDays.filter((day) => day.seatsTaken < day.seatLimit);
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
        <SectionTitle>Find patient</SectionTitle>
        <div
          className="flex flex-wrap gap-2"
          data-testid="clinical-line-switcher"
        >
          <p className="w-full text-sm font-semibold">
            Line: {CLINICAL_LINE_LABELS[line]}
          </p>
          {CLINICAL_LINES.map((item) => (
            <Button
              key={item}
              type="button"
              size="sm"
              variant={item === line ? "secondary" : "ghost"}
              data-testid={`clinical-line-${item}`}
              onClick={() => setLine(item)}
            >
              {CLINICAL_LINE_LABELS[item]}
            </Button>
          ))}
        </div>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void lookup();
          }}
        >
          <Input
            id="clinical-exact-lookup"
            label="Patient QR or registration number"
            value={exact}
            onChange={(event) => {
              lookupGenerationRef.current += 1;
              setExact(event.target.value);
            }}
            placeholder="Scan with USB scanner or type number"
          />
          <Button type="submit" disabled={busy}>
            Search
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
              Open slip
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
                Age {record.patient.age ?? "—"} · {genderLabel(record.patient.gender)}
              </p>
            </div>
            {canMutate && record.transcription?.locked_at ? (
              <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p>
                  First record is locked. Edit fields below and add a correction with a
                  reason — original record is preserved.
                </p>
                <Input
                  id="clinical-correction-reason"
                  label="Reason for correction"
                  value={correctionReason}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                />
              </div>
            ) : null}

            <form
              className="space-y-4"
              noValidate={false}
              onSubmit={(event) => {
                event.preventDefault();
                if (record.transcription?.locked_at) {
                  void addCorrection();
                } else {
                  void save();
                }
              }}
            >
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
                        disabled={!canMutate || hasTranscription}
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
                label="Other diagnosis (optional)"
                value={diagnosisOther}
                onChange={(e) => {
                  setDiagnosisOther(e.target.value);
                  setDiagnosisOtherEdited(true);
                }}
                disabled={!canMutate || hasTranscription}
                hint="Free text — will not be split by commas"
                maxLength={120}
              />
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                id="clinical-sugar"
                label="Blood sugar (optional)"
                value={bloodSugar}
                onChange={(e) => setBloodSugar(e.target.value)}
                disabled={!canMutate || hasTranscription}
                hint="mg/dL, 20–1000"
                inputMode="decimal"
                pattern="[0-9]+([.][0-9]+)?"
                maxLength={32}
              />
              <Input
                id="clinical-bp"
                label="Blood pressure (optional)"
                value={bloodPressure}
                onChange={(e) => setBloodPressure(e.target.value)}
                disabled={!canMutate || hasTranscription}
                hint="systolic/diastolic, e.g. 120/80"
                inputMode="numeric"
                pattern="[0-9]{2,3}/[0-9]{2,3}"
                maxLength={32}
              />
            </div>
            <Input
              id="clinical-remarks"
              label="Remarks / Advice"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              disabled={!canMutate || hasTranscription}
              maxLength={2000}
            />
            {fields.medicines ? (
            <Input
              id="clinical-medicines"
              label="Prescription medicines"
              value={medicines}
              onChange={(e) => setMedicines(e.target.value)}
              disabled={!canMutate}
              maxLength={2000}
            />
            ) : null}
            {fields.specs ? (
            <Card className="space-y-3">
              <SectionTitle>Spectacle prescription (Specs)</SectionTitle>
              <label className="block text-sm font-semibold">
                Spectacle type
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
                          inputMode={field === "vision" ? undefined : "decimal"}
                          maxLength={32}
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
                required={Boolean(specType)}
                inputMode="decimal"
                pattern="[0-9]+([.][0-9]+)?"
              />
            </Card>
            ) : null}
            {fields.ot ? (
            <Card className="space-y-3">
              <SectionTitle>Surgery (OT) details</SectionTitle>
              <label className="block text-sm font-semibold">
                Eye
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
                required={Boolean(otEye)}
                maxLength={200}
              />
              <Input
                id="ot-notes"
                label="OT notes"
                value={otNotes}
                disabled={!canMutate}
                onChange={(event) => setOtNotes(event.target.value)}
                maxLength={1000}
              />
            </Card>
            ) : null}
            {canMutate ? (
              <>
                <Button
                  type="submit"
                  disabled={busy || Boolean(record.transcription?.locked_at)}
                >
                  Save record
                </Button>
                {record.transcription?.locked_at ? (
                  <Button
                    type="submit"
                    disabled={busy || !correctionReason.trim()}
                  >
                    Add correction
                  </Button>
                ) : null}
              </>
            ) : null}
            </form>
          </Card>
          <div className="grid gap-3 md:grid-cols-1">
            {(Object.keys(OUTCOMES) as Array<keyof typeof OUTCOMES>)
              .filter((kind) => kind === lineKind(line))
              .map((kind) => {
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
                      ? `Status: ${outcomeLabel(current.outcome)}`
                      : "Status: no outcome yet"}
                  </p>
                  {kind === "ot" && canMutate && !current ? (
                    openOtDays.length ? (
                      <label className="block text-sm font-semibold">
                        Surgery date
                        <select
                          className={selectClass}
                          data-testid="ot-day-picker"
                          value={otDayId}
                          onChange={(event) => setOtDayId(event.target.value)}
                        >
                          {openOtDays.map((day) => (
                            <option key={day.id} value={day.id}>
                              {formatCampDay(day.dayDate)} · {day.venue} ·{" "}
                              {day.seatLimit - day.seatsTaken} seats
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <p className="text-sm text-danger">
                        All surgery dates are full — ask admin to add a new
                        date.
                      </p>
                    )
                  ) : null}
                  {canMutate && medicineNotAvailableOpen ? (
                    <div className="space-y-3">
                      <label
                        htmlFor="unavailable-medicines"
                        className="block text-sm font-semibold"
                      >
                        Which medicines were not available?
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
                        Save: medicine not available
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
                    ? lineDecisions(line).map((outcome) => (
                        <Button
                          key={outcome}
                          type="button"
                          variant="secondary"
                          disabled={
                            busy ||
                            Boolean(current) ||
                            !hasTranscription ||
                            (kind === "ot" &&
                              outcome === "deferred" &&
                              !otDayId)
                          }
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
                        Reprint slip
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
                          Replace slip
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
              <SectionTitle>Previous camp history · read-only</SectionTitle>
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
          <SectionTitle>Pending follow-up from previous camps</SectionTitle>
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
                  Dispensed — mark complete
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
              <span id="slip-replace-title">Replace deferred slip</span>
            </SectionTitle>
            <Input
              id="slip-replace-date"
              label="New date"
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
              label="New venue"
              value={slipReplace.venue}
              onChange={(e) =>
                setSlipReplace((current) =>
                  current ? { ...current, venue: e.target.value } : current,
                )
              }
            />
            <Input
              id="slip-replace-reason"
              label="Reason for replacement"
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
