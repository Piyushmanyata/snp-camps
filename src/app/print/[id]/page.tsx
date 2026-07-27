import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { canRegisterPatients, getSessionProfile } from "@/lib/auth";
import { isPatientUuid } from "@/lib/qr";
import { loadPrintSlips } from "@/lib/print-slip-load";
import { DeskSlipPrint } from "@/components/desk-slip-print";
import { RegistrationPrescriptionSheet } from "@/components/registration-prescription-sheet";
import { PrintActions } from "@/components/print-actions";

export default async function PrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ auto?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const autoPrint = query.auto === "1" || query.auto === "true";
  const { profile } = await getSessionProfile();
  if (!profile) redirect("/login");
  if (!canRegisterPatients(profile.role)) {
    redirect(profile.role === "doctor" ? "/doctor" : "/");
  }

  if (!isPatientUuid(id)) {
    return (
      <main id="main" className="mx-auto max-w-lg px-4 py-10">
        <div className="rounded-2xl border border-border bg-card p-6 text-center">
          <p className="text-lg font-semibold">Invalid patient link</p>
          <p className="mt-1 text-sm text-muted">
            Check the QR or registration number and try again.
          </p>
        </div>
      </main>
    );
  }

  const supabase = await createClient();
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const origin = process.env.NEXT_PUBLIC_SITE_URL || `${proto}://${host}`;

  const loaded = await loadPrintSlips(supabase, [id], origin);
  const slip = loaded[0];

  if (!slip) {
    return (
      <main id="main" className="mx-auto max-w-lg px-4 py-10">
        <div className="rounded-2xl border border-border bg-card p-6 text-center">
          <p className="text-lg font-semibold">Patient not found</p>
          <p className="mt-1 text-sm text-muted">
            Check the QR or registration number and try again.
          </p>
        </div>
      </main>
    );
  }

  const deskHref = profile.role === "admin" ? "/admin" : "/volunteer";
  const deskLabel =
    profile.role === "admin" ? "Admin dashboard" : "Volunteer desk";

  // #108 — camp paper_fallback_mode prints the blank Prescription Sheet
  // instead of the desk slip. One or the other, never both.
  if (slip.paperFallbackMode) {
    return (
      <main id="main" className="mx-auto max-w-[220mm] px-3 py-4 sm:px-4 sm:py-6">
        <PrintActions
          className="no-print mb-4"
          patients={[
            {
              id: slip.patient.id,
              regNo: slip.patient.reg_no,
              name: slip.patient.full_name,
              queueStatus: slip.queueStatus ?? "waiting",
            },
          ]}
          deskHref={deskHref}
          deskLabel={deskLabel}
          autoPrint={autoPrint}
        />
        <RegistrationPrescriptionSheet
          patient={{
            id: slip.patient.id,
            reg_no: slip.patient.reg_no,
            full_name: slip.patient.full_name,
            age: slip.age,
            gender: slip.gender,
          }}
          camp={slip.camp}
          campDayDate={slip.campDayDate}
          qrValue={slip.qrValue}
        />
        <p className="no-print mt-3 text-center text-xs text-muted">
          Prescription Sheet · blank form for handwritten notes · Patient QR is
          for <strong>staff scan only</strong>.
        </p>
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto max-w-[220mm] px-3 py-4 sm:px-4 sm:py-6">
      <DeskSlipPrint
        slips={[
          {
            patient: slip.patient,
            camp: slip.camp,
            campDayDate: slip.campDayDate,
            qrValue: slip.qrValue,
            queueStatus: slip.queueStatus,
          },
        ]}
        deskHref={deskHref}
        deskLabel={deskLabel}
        autoPrint={autoPrint}
      />
    </main>
  );
}
