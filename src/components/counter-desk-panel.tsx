"use client";

import { useState, useTransition, useEffect, useCallback, useId } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  COUNTER_STATIONS,
  type CounterStationKind,
  type CounterPatientRecord,
  type CounterStationQueueItem,
  type TreatmentOrderRow,
  isPatientCompletedDerived,
} from "@/lib/counter-desk";
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Input,
  SectionTitle,
  SuccessBox,
} from "@/components/ui";
import { parsePatientIdFromQr, parseRegistrationNumber } from "@/lib/qr";
import { QrScannerLazy } from "@/components/qr-scanner-lazy";

export function CounterDeskPanel({
  campId,
  initialStation = "pharmacy",
}: {
  campId: string | null;
  initialStation?: CounterStationKind;
}) {
  const [station, setStation] = useState<CounterStationKind>(initialStation);
  const [queueItems, setQueueItems] = useState<CounterStationQueueItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);

  const [searchInput, setSearchInput] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchSuccess, setSearchSuccess] = useState<string | null>(null);

  const [activePatient, setActivePatient] = useState<CounterPatientRecord | null>(null);
  const [loadingPatient, setLoadingPatient] = useState(false);

  const [isPending, startTransition] = useTransition();

  // Defer form state per order id
  const [deferringOrderId, setDeferringOrderId] = useState<string | null>(null);
  const [deferredDate, setDeferredDate] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [deferredVenue, setDeferredVenue] = useState<string>("");

  const searchInputId = useId();

  // Load pending queue for current station
  const fetchStationQueue = useCallback(
    async (kind: CounterStationKind) => {
      if (!campId) return;
      setQueueLoading(true);
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("treatment_orders")
          .select(`
            id,
            kind,
            created_at,
            patient_id,
            patients!inner (
              id,
              reg_no,
              full_name,
              queue_status,
              camp_id
            )
          `)
          .eq("camp_id", campId)
          .eq("kind", kind)
          .eq("status", "pending")
          .order("created_at", { ascending: true });

        if (error) {
          console.error("Queue fetch error:", error);
          setQueueItems([]);
        } else if (data) {
          const items: CounterStationQueueItem[] = data.map((row: any) => {
            const p = row.patients;
            return {
              order_id: row.id,
              created_at: row.created_at,
              kind: row.kind as CounterStationKind,
              patient_id: p.id,
              reg_no: p.reg_no,
              full_name: p.full_name,
              queue_status: p.queue_status,
            };
          });
          setQueueItems(items);
        }
      } catch (err) {
        console.error("Failed to fetch queue:", err);
      } finally {
        setQueueLoading(false);
      }
    },
    [campId]
  );

  useEffect(() => {
    fetchStationQueue(station);
  }, [station, fetchStationQueue]);

  // Load full patient details (prescription + all treatment orders)
  const fetchPatientDetails = useCallback(
    async (patientIdOrRegNo: { patientId?: string; regNo?: number }) => {
      if (!campId) return;
      setLoadingPatient(true);
      setSearchError(null);
      setSearchSuccess(null);
      setDeferringOrderId(null);

      try {
        const supabase = createClient();
        let patientQuery = supabase
          .from("patients")
          .select("id, reg_no, full_name, phone, queue_status, camp_id")
          .eq("camp_id", campId);

        if (patientIdOrRegNo.patientId) {
          patientQuery = patientQuery.eq("id", patientIdOrRegNo.patientId);
        } else if (patientIdOrRegNo.regNo) {
          patientQuery = patientQuery.eq("reg_no", patientIdOrRegNo.regNo);
        } else {
          setLoadingPatient(false);
          return;
        }

        const { data: patientData, error: patientError } = await patientQuery.maybeSingle();

        if (patientError || !patientData) {
          setSearchError("Patient not found in active camp.");
          setActivePatient(null);
          setLoadingPatient(false);
          return;
        }

        const patientId = patientData.id;

        // Fetch prescription
        const { data: pData } = await supabase
          .from("prescriptions")
          .select(`
            id,
            diagnosis,
            examination,
            medicines,
            advice,
            spectacles_type,
            doctor_id,
            profiles!doctor_id ( full_name )
          `)
          .eq("patient_id", patientId)
          .maybeSingle();

        let prescription: CounterPatientRecord["prescription"] = null;
        if (pData) {
          prescription = {
            id: pData.id,
            diagnosis: pData.diagnosis,
            examination: pData.examination,
            medicines: pData.medicines,
            advice: pData.advice,
            spectacles_type: pData.spectacles_type as "fixed" | "bifocal" | null,
            doctor_name: (pData as any).profiles?.full_name || "Doctor",
          };
        }

        // Fetch all treatment orders for this patient
        const { data: ordersData } = await supabase
          .from("treatment_orders")
          .select(`
            id,
            prescription_id,
            patient_id,
            camp_id,
            kind,
            status,
            created_at,
            closed_at,
            closed_by,
            deferred_date,
            deferred_venue
          `)
          .eq("patient_id", patientId)
          .order("created_at", { ascending: true });

        const orders: TreatmentOrderRow[] = (ordersData || []).map((o: any) => ({
          id: o.id,
          prescription_id: o.prescription_id,
          patient_id: o.patient_id,
          camp_id: o.camp_id,
          kind: o.kind as CounterStationKind,
          status: o.status,
          created_at: o.created_at,
          closed_at: o.closed_at,
          closed_by: o.closed_by,
          deferred_date: o.deferred_date,
          deferred_venue: o.deferred_venue,
        }));

        const isCompleted = isPatientCompletedDerived(patientData.queue_status, orders);

        setActivePatient({
          id: patientData.id,
          reg_no: patientData.reg_no,
          full_name: patientData.full_name,
          phone: patientData.phone,
          queue_status: patientData.queue_status,
          camp_id: patientData.camp_id,
          prescription,
          orders,
          isCompleted,
        });
      } catch (err) {
        console.error("Error loading patient details:", err);
        setSearchError("Could not load patient details.");
      } finally {
        setLoadingPatient(false);
      }
    },
    [campId]
  );

  const handleSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const raw = searchInput.trim();
    if (!raw) return;

    const parsedUuid = parsePatientIdFromQr(raw);
    if (parsedUuid) {
      fetchPatientDetails({ patientId: parsedUuid });
      return;
    }

    const regNo = parseRegistrationNumber(raw);
    if (regNo) {
      fetchPatientDetails({ regNo });
      return;
    }

    setSearchError("Enter a valid Registration Number or scan QR code.");
  };

  const handleResolveOrder = async (
    orderId: string,
    action: "fulfilled" | "deferred" | "cancelled",
    date?: string | null,
    venue?: string | null
  ) => {
    setSearchError(null);
    setSearchSuccess(null);

    startTransition(async () => {
      try {
        const res = await fetch("/api/counter/resolve-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderId,
            action,
            deferredDate: date || null,
            deferredVenue: venue || null,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          setSearchError(data.error || "Failed to update order.");
          return;
        }

        setSearchSuccess(`Order ${action} successfully!`);
        setDeferringOrderId(null);

        // Refresh active patient details & queue
        if (activePatient) {
          await fetchPatientDetails({ patientId: activePatient.id });
        }
        fetchStationQueue(station);
      } catch (err) {
        console.error("Failed to resolve order:", err);
        setSearchError("Network or server error while updating order.");
      }
    });
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Station Selector Card */}
      <Card className="bg-card border-2 border-border shadow-sm !p-4 sm:!p-5">
        <SectionTitle hint="Choose your counter assignment">
          Counter Station
        </SectionTitle>
        <div
          role="radiogroup"
          aria-label="Counter stations"
          className="grid grid-cols-1 gap-2.5 sm:grid-cols-3"
        >
          {COUNTER_STATIONS.map((st) => {
            const isSelected = station === st.kind;
            return (
              <button
                key={st.kind}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => setStation(st.kind)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setStation(st.kind);
                  }
                }}
                className={`pressable flex min-h-[52px] cursor-pointer flex-col justify-center rounded-xl px-4 py-3 text-left transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                  isSelected
                    ? "border-2 border-brand bg-brand-soft text-brand font-bold shadow-sm"
                    : "border border-border bg-card text-foreground hover:bg-background/80"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-base font-bold sm:text-lg">
                    {st.shortLabel}
                  </span>
                  {isSelected && (
                    <span className="h-3 w-3 rounded-full bg-brand" aria-hidden="true" />
                  )}
                </div>
                <span className="text-xs text-muted font-normal mt-0.5">
                  {st.hint}
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Main Grid: Queue & Patient Lookup */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Station Queue List Column */}
        <div className="lg:col-span-4 space-y-4">
          <Card className="bg-card border-2 border-border shadow-sm !p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-base font-bold text-foreground sm:text-lg">
                  Pending Queue
                </h2>
                <p className="text-xs text-muted">
                  {COUNTER_STATIONS.find((s) => s.kind === station)?.shortLabel} ({queueItems.length} waiting)
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => fetchStationQueue(station)}
                loading={queueLoading}
                aria-label="Refresh station queue"
                className="!min-h-[44px] !w-auto px-3"
              >
                ↻ Refresh
              </Button>
            </div>

            {!campId ? (
              <p className="text-xs text-muted py-4 text-center">
                No active camp selected.
              </p>
            ) : queueLoading ? (
              <p className="text-xs text-muted py-4 text-center" role="status">
                Loading queue…
              </p>
            ) : queueItems.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-4 text-center">
                <p className="text-sm font-semibold text-foreground">Queue Empty</p>
                <p className="text-xs text-muted mt-1">
                  No patients waiting for {COUNTER_STATIONS.find((s) => s.kind === station)?.shortLabel}.
                </p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                {queueItems.map((item) => {
                  const isCurrentActive = activePatient?.id === item.patient_id;
                  return (
                    <button
                      key={item.order_id}
                      type="button"
                      onClick={() => fetchPatientDetails({ patientId: item.patient_id })}
                      className={`pressable w-full min-h-[48px] text-left p-3 rounded-xl border transition-colors flex items-center justify-between ${
                        isCurrentActive
                          ? "border-brand bg-brand-soft font-bold text-brand ring-1 ring-brand/30"
                          : "border-border bg-card text-foreground hover:bg-brand-soft/50"
                      }`}
                    >
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold uppercase tracking-wide text-brand">
                            Reg #{item.reg_no}
                          </span>
                        </div>
                        <p className="truncate text-sm font-bold mt-0.5">
                          {item.full_name}
                        </p>
                      </div>
                      <span className="shrink-0 text-[11px] font-semibold text-muted bg-background px-2 py-1 rounded-md border border-border">
                        Select →
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* Active Patient & Search Column */}
        <div className="lg:col-span-8 space-y-4">
          {/* Patient Lookup Input */}
          <Card className="bg-card border-2 border-border shadow-sm !p-4 sm:!p-5">
            <SectionTitle hint="Scan QR slip or enter Reg #">
              Patient Search
            </SectionTitle>
            <form onSubmit={handleSearch} className="space-y-3">
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <label htmlFor={searchInputId} className="block text-sm font-semibold text-foreground/90 mb-1">
                    Registration Number or QR Code
                  </label>
                  <input
                    id={searchInputId}
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="e.g. 1042 or scan slip"
                    className="min-h-[48px] w-full rounded-xl border border-border bg-card px-3.5 text-base text-foreground outline-none transition-[border-color] duration-150 placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/20"
                  />
                </div>
                <Button
                  type="submit"
                  variant="primary"
                  loading={loadingPatient}
                  disabled={!searchInput.trim()}
                  className="!min-h-[48px] sm:w-auto px-6"
                >
                  Search Patient
                </Button>
              </div>

              {/* QR Scanner Collapsible / Trigger */}
              <div className="pt-2">
                <QrScannerLazy
                  mode="volunteer"
                  doctors={[]}
                  disabledReason={
                    campId
                      ? undefined
                      : "No active camp. Ask an admin to activate one."
                  }
                />
              </div>
            </form>

            <div className="mt-3">
              <ErrorBox message={searchError} />
              <SuccessBox message={searchSuccess} />
            </div>
          </Card>

          {/* Active Patient Details Card */}
          {activePatient ? (
            <Card className="bg-card border-2 border-border shadow-md !p-4 sm:!p-6 space-y-5">
              {/* Header / Identity Banner */}
              <div className="flex flex-col gap-2 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-brand text-white px-2.5 py-1 text-xs font-bold">
                      Reg #{activePatient.reg_no}
                    </span>
                    <Badge tone={activePatient.queue_status === "seen" ? "ok" : "wait"}>
                      {activePatient.queue_status === "seen" ? "Doctor Seen" : activePatient.queue_status}
                    </Badge>
                  </div>
                  <h3 className="mt-1 text-xl font-bold text-foreground sm:text-2xl">
                    {activePatient.full_name}
                  </h3>
                  {activePatient.phone ? (
                    <p className="text-xs text-muted mt-0.5">Phone: {activePatient.phone}</p>
                  ) : null}
                </div>

                {/* Derived Completion Banner */}
                {activePatient.isCompleted && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="rounded-xl border-2 border-brand bg-success-soft px-4 py-3 text-brand"
                  >
                    <p className="text-sm font-bold flex items-center gap-1.5">
                      <span aria-hidden="true">✓</span> All Orders Completed
                    </p>
                    <p className="text-xs font-medium text-brand/90 mt-0.5">
                      Patient workflow complete.
                    </p>
                  </div>
                )}
              </div>

              {/* Doctor Prescription Notes */}
              <div>
                <h4 className="text-sm font-bold uppercase tracking-wider text-muted mb-2">
                  Doctor's Prescription & Notes
                </h4>
                {activePatient.prescription ? (
                  <div className="rounded-xl border border-border bg-background/60 p-4 space-y-3">
                    <p className="text-xs font-semibold text-muted">
                      Prescribed by: <span className="text-foreground font-bold">{activePatient.prescription.doctor_name}</span>
                    </p>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
                      {activePatient.prescription.diagnosis && (
                        <div>
                          <span className="text-xs font-bold text-muted uppercase block">Diagnosis</span>
                          <span className="font-semibold text-foreground">{activePatient.prescription.diagnosis}</span>
                        </div>
                      )}
                      {activePatient.prescription.spectacles_type && (
                        <div>
                          <span className="text-xs font-bold text-muted uppercase block">Spectacles Type</span>
                          <span className="font-semibold text-brand uppercase">
                            {activePatient.prescription.spectacles_type}
                          </span>
                        </div>
                      )}
                      {activePatient.prescription.examination && (
                        <div className="sm:col-span-2">
                          <span className="text-xs font-bold text-muted uppercase block">Examination</span>
                          <span className="font-medium text-foreground">{activePatient.prescription.examination}</span>
                        </div>
                      )}
                      {activePatient.prescription.medicines && (
                        <div className="sm:col-span-2">
                          <span className="text-xs font-bold text-muted uppercase block">Medicines</span>
                          <span className="font-semibold text-foreground bg-brand-soft/40 p-2 rounded-md block border border-brand/10">
                            {activePatient.prescription.medicines}
                          </span>
                        </div>
                      )}
                      {activePatient.prescription.advice && (
                        <div className="sm:col-span-2">
                          <span className="text-xs font-bold text-muted uppercase block">Advice</span>
                          <span className="font-medium text-foreground">{activePatient.prescription.advice}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted italic">No prescription recorded yet.</p>
                )}
              </div>

              {/* Treatment Orders List & Actions */}
              <div>
                <h4 className="text-sm font-bold uppercase tracking-wider text-muted mb-2">
                  Treatment Orders ({activePatient.orders.length})
                </h4>

                {activePatient.orders.length === 0 ? (
                  <p className="text-sm text-muted italic">No treatment orders issued for this patient.</p>
                ) : (
                  <div className="space-y-3">
                    {activePatient.orders.map((ord) => {
                      const isPendingOrder = ord.status === "pending";
                      const isDeferring = deferringOrderId === ord.id;
                      const stationMeta = COUNTER_STATIONS.find((s) => s.kind === ord.kind);

                      return (
                        <div
                          key={ord.id}
                          className={`rounded-xl border p-4 space-y-3 transition-colors ${
                            isPendingOrder
                              ? "border-brand/40 bg-card shadow-sm"
                              : "border-border bg-background/50 opacity-90"
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-base text-foreground">
                                {stationMeta?.label || ord.kind.toUpperCase()}
                              </span>
                              {ord.kind === station && (
                                <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold uppercase text-brand border border-brand/20">
                                  Current Station
                                </span>
                              )}
                            </div>

                            <Badge
                              tone={
                                ord.status === "fulfilled"
                                  ? "ok"
                                  : ord.status === "pending"
                                  ? "wait"
                                  : ord.status === "deferred"
                                  ? "default"
                                  : "danger"
                              }
                            >
                              {ord.status === "fulfilled"
                                ? "Fulfilled"
                                : ord.status === "pending"
                                ? "Pending"
                                : ord.status === "deferred"
                                ? "Deferred"
                                : "Cancelled"}
                            </Badge>
                          </div>

                          {/* Deferred Info Display */}
                          {ord.status === "deferred" && (
                            <div className="text-xs font-medium text-muted bg-background p-2.5 rounded-lg border border-border">
                              <p>
                                <strong className="text-foreground">Deferred Date:</strong>{" "}
                                {ord.deferred_date ? new Date(ord.deferred_date).toLocaleDateString() : "TBD"}
                              </p>
                              {ord.deferred_venue && (
                                <p>
                                  <strong className="text-foreground">Deferred Venue:</strong> {ord.deferred_venue}
                                </p>
                              )}
                            </div>
                          )}

                          {/* Closed Info Display (Prevent Double Fulfillment) */}
                          {!isPendingOrder && ord.closed_at && (
                            <p className="text-xs text-muted font-medium">
                              Closed on {new Date(ord.closed_at).toLocaleString()}
                            </p>
                          )}

                          {/* Order Action Buttons for Pending Orders */}
                          {isPendingOrder && (
                            <div className="pt-2 border-t border-border space-y-3">
                              {!isDeferring ? (
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                  {/* Fulfil One-Tap Button */}
                                  <Button
                                    type="button"
                                    variant="primary"
                                    loading={isPending}
                                    onClick={() => handleResolveOrder(ord.id, "fulfilled")}
                                    className="!min-h-[44px] text-sm font-bold bg-emerald-600 hover:bg-emerald-700 text-white"
                                  >
                                    ✓ Fulfil Order
                                  </Button>

                                  {/* Defer Button */}
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    disabled={isPending}
                                    onClick={() => setDeferringOrderId(ord.id)}
                                    className="!min-h-[44px] text-sm font-semibold"
                                  >
                                    📅 Defer…
                                  </Button>

                                  {/* Cancel Button */}
                                  <Button
                                    type="button"
                                    variant="danger"
                                    loading={isPending}
                                    onClick={() => handleResolveOrder(ord.id, "cancelled")}
                                    className="!min-h-[44px] text-sm font-semibold"
                                  >
                                    ✕ Cancel
                                  </Button>
                                </div>
                              ) : (
                                /* Defer Date & Venue Sub-Form */
                                <div className="bg-brand-soft/30 p-3 rounded-xl border border-brand/20 space-y-3">
                                  <h5 className="text-xs font-bold text-brand uppercase">
                                    Defer Order Details
                                  </h5>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    <div>
                                      <label className="block text-xs font-semibold text-foreground mb-1">
                                        Deferred Date *
                                      </label>
                                      <input
                                        type="date"
                                        value={deferredDate}
                                        onChange={(e) => setDeferredDate(e.target.value)}
                                        className="min-h-[44px] w-full rounded-xl border border-border bg-card px-3 text-sm"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-xs font-semibold text-foreground mb-1">
                                        Venue / Hospital (Optional)
                                      </label>
                                      <input
                                        type="text"
                                        value={deferredVenue}
                                        onChange={(e) => setDeferredVenue(e.target.value)}
                                        placeholder="e.g. Civil Hospital"
                                        className="min-h-[44px] w-full rounded-xl border border-border bg-card px-3 text-sm"
                                      />
                                    </div>
                                  </div>

                                  <div className="flex gap-2 justify-end pt-1">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setDeferringOrderId(null)}
                                      className="!min-h-[44px] px-3"
                                    >
                                      Back
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="primary"
                                      size="sm"
                                      loading={isPending}
                                      disabled={!deferredDate}
                                      onClick={() =>
                                        handleResolveOrder(ord.id, "deferred", deferredDate, deferredVenue)
                                      }
                                      className="!min-h-[44px] px-4"
                                    >
                                      Confirm Defer
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Card>
          ) : (
            <Card className="bg-card border-2 border-border shadow-sm p-8 text-center">
              <p className="text-base font-semibold text-foreground">
                No Patient Selected
              </p>
              <p className="text-xs text-muted max-w-sm mx-auto mt-1">
                Select a patient from the station queue on the left, scan a thermal desk slip QR, or enter a registration number above.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
