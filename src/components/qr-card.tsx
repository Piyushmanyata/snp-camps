import { QrCode } from "@/components/qr-code";
import { patientScanUrl } from "@/lib/qr";

/** Patient phone / confirmation: big reg no + staff-scan QR. Not for login. */
export function QrCard({
  value,
  regNo,
  patientId,
}: {
  value?: string;
  regNo: number;
  patientId?: string;
}) {
  const payload =
    value && value.length > 8
      ? value
      : patientId
        ? patientScanUrl(patientId)
        : value || "";

  if (!payload) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted">
        Preparing QR…
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card p-6 shadow-md transition-all duration-200 hover:shadow-lg ring-1 ring-emerald-500/15">
      <div className="text-center">
        <p className="text-xs font-bold uppercase tracking-wider text-muted">
          Registration no.
        </p>
        <p
          className="tabular mt-1 text-5xl font-bold tracking-tight text-brand sm:text-6xl"
          translate="no"
        >
          {regNo}
        </p>
      </div>
      <div className="rounded-2xl border border-emerald-500/20 bg-white p-4 shadow-sm ring-1 ring-emerald-500/10">
        <QrCode
          value={payload}
          size={220}
          level="H"
          includeMargin
          fgColor="#047857"
        />
      </div>
      <div className="text-center">
        <p className="text-sm font-bold text-brand">
          Show this QR to camp staff
        </p>
        <p className="prose-help mt-1 text-xs text-muted">
          Volunteers scan to assign a doctor · not a login code
        </p>
      </div>
    </div>
  );
}
