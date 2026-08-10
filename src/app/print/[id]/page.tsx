import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { canRegisterPatients, getSessionProfile, roleHome } from "@/lib/auth";
import { isPatientUuid } from "@/lib/qr";
import { loadPrintSlips } from "@/lib/print-slip-load";
import { PrescriptionSheet } from "@/components/prescription-sheet";
import { resolvePrescriptionTemplate } from "@/lib/prescription-template";
import { PrintActions } from "@/components/print-actions";
import { ScaleToFit } from "@/components/scale-to-fit";
import { Card } from "@/components/ui";

export const metadata: Metadata = { title: "Print prescription" };

function NotPrintable({ title, detail }: { title: string; detail: string }) {
  return (
    <main id="main" className="mx-auto max-w-lg px-4 py-10">
      <Card className="text-center">
        <p className="text-lg font-semibold">{title}</p>
        <p className="mt-1 text-sm text-muted">{detail}</p>
      </Card>
    </main>
  );
}

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
    redirect(roleHome(profile.role) || "/");
  }

  if (!isPatientUuid(id)) {
    return (
      <NotPrintable
        title="Invalid patient link"
        detail="Check the QR or registration number and try again."
      />
    );
  }

  const supabase = await createClient();
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const origin = process.env.NEXT_PUBLIC_SITE_URL || `${proto}://${host}`;

  const loaded = await loadPrintSlips(supabase, [id], origin);
  const record = loaded[0];

  if (!record) {
    return (
      <NotPrintable
        title="Patient not found"
        detail="Check the QR or registration number and try again."
      />
    );
  }

  const deskHref = profile.role === "admin" ? "/admin" : "/volunteer";
  const deskLabel =
    profile.role === "admin" ? "Admin dashboard" : "Volunteer desk";

  return (
    <main id="main" className="mx-auto max-w-[220mm] px-3 py-4 sm:px-4 sm:py-6">
      <PrintActions
        className="no-print mb-4"
        patients={[
          {
            id: record.patient.id,
            regNo: record.patient.reg_no,
            name: record.patient.full_name,
            queueStatus: record.queueStatus ?? "waiting",
          },
        ]}
        deskHref={deskHref}
        deskLabel={deskLabel}
        autoPrint={autoPrint}
      />
      <ScaleToFit>
        <PrescriptionSheet
          patient={record.patient}
          camp={record.camp}
          campDayDate={record.campDayDate}
          qrValue={record.qrValue}
          template={resolvePrescriptionTemplate(record.prescriptionTemplate)}
        />
      </ScaleToFit>
      <p className="no-print mt-3 text-center text-xs text-muted">
        Parchi · clinical fields haath se likhe jaate hain · QR sirf staff scan
        ke liye
      </p>
    </main>
  );
}
