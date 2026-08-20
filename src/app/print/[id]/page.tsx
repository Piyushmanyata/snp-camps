import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { canRegisterPatients, getSessionProfile, roleHome } from "@/lib/auth";
import { isPatientUuid } from "@/lib/qr";
import { loadPrintSlips } from "@/lib/print-slip-load";
import { PrescriptionSheet } from "@/components/prescription-sheet";
import { resolvePrescriptionTemplate } from "@/lib/prescription-template";
import { PrintActions } from "@/components/print-actions";
import { ScaleToFit } from "@/components/scale-to-fit";
import { Card } from "@/components/ui";
import { isPrintWindowOpen } from "@/lib/print-window";
import type { CampDayStats } from "@/lib/types";

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
        title="Yeh patient link galat hai"
        detail="QR ya registration number check karke dobara koshish karein."
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
        title="Patient nahi mila"
        detail="QR ya registration number check karke dobara koshish karein."
      />
    );
  }

  const { data: dayStats } = await supabase.rpc("camp_day_stats", {
    p_camp_id: record.campId,
  });
  const days = (dayStats || []) as CampDayStats[];
  const campDay = days.find((day) => day.day_date === record.campDayDate);
  const admin = createServiceRoleClient();
  if (admin) {
    const { data: gate } = await admin
      .from("patients")
      .select("provenance, confirmation_override_at, persons(duplicate_key)")
      .eq("id", id)
      .maybeSingle();
    const person = Array.isArray(gate?.persons) ? gate?.persons[0] : gate?.persons;
    if (
      gate?.provenance === "manual_exception" &&
      !gate.confirmation_override_at &&
      !person?.duplicate_key
    ) {
      return (
        <NotPrintable
          title="Pehle Aadhaar confirm karein"
          detail="Manual exception print se pehle card scan ya team-lead override chahiye."
        />
      );
    }
  }

  if (
    !isPrintWindowOpen({
      dayDate: record.campDayDate,
      printingOpen: campDay?.printing_open === true,
    })
  ) {
    return (
      <NotPrintable
        title="Print band hai"
        detail="Admin se print window khulwaein. Register abhi ho sakta hai."
      />
    );
  }

  const deskHref = profile.role === "admin" ? "/admin" : "/volunteer";

  return (
    <main id="main" className="mx-auto max-w-[220mm] px-3 py-4 sm:px-4 sm:py-6">
      <PrintActions
        className="no-print mb-4"
        patients={[
          {
            id: record.patient.id,
            regNo: record.patient.reg_no,
            name: record.patient.full_name,
            queueStatus: record.queueStatus ?? "registered",
          },
        ]}
        deskHref={deskHref}
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
