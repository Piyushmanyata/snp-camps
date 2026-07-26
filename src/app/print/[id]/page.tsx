import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { canRegisterPatients, getSessionProfile } from "@/lib/auth";
import { isPatientUuid, patientScanUrl } from "@/lib/qr";

const DeskSlipPrint = dynamic(
  () =>
    import("@/components/desk-slip-print").then((m) => ({
      default: m.DeskSlipPrint,
    })),
);

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

  const { data: patient, error: patientErr } = await supabase
    .from("patients")
    .select(
      "id, reg_no, full_name, queue_status, camps(name, venue, camp_date), camp_days(day_date)",
    )
    .eq("id", id)
    .maybeSingle();

  if (patientErr || !patient) {
    return (
      <main id="main" className="mx-auto max-w-lg px-4 py-10">
        <div className="rounded-2xl border border-border bg-card p-6 text-center">
          <p className="text-lg font-semibold">Patient not found</p>
          <p className="mt-1 text-sm text-muted">
            {patientErr
              ? "The patient record could not be loaded. Try again or ask an admin."
              : "Check the QR or registration number and try again."}
          </p>
        </div>
      </main>
    );
  }

  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const origin = process.env.NEXT_PUBLIC_SITE_URL || `${proto}://${host}`;
  const campRel = patient.camps as
    | { name: string; venue: string | null; camp_date: string | null }
    | { name: string; venue: string | null; camp_date: string | null }[]
    | null;
  const camp = Array.isArray(campRel) ? campRel[0] ?? null : campRel;
  const dayRel = patient.camp_days as
    | { day_date: string }
    | { day_date: string }[]
    | null;
  const campDayDate = Array.isArray(dayRel)
    ? dayRel[0]?.day_date ?? null
    : dayRel?.day_date ?? null;

  // Compact encoding required — no long-URL fallback on the slip.
  const qrValue = patientScanUrl(patient.id, origin);

  return (
    <main id="main" className="mx-auto max-w-[220mm] px-3 py-4 sm:px-4 sm:py-6">
      <DeskSlipPrint
        patient={{
          id: patient.id,
          reg_no: patient.reg_no,
          full_name: patient.full_name,
        }}
        camp={camp}
        campDayDate={campDayDate}
        qrValue={qrValue}
        queueStatus={patient.queue_status}
        deskHref={profile.role === "admin" ? "/admin" : "/volunteer"}
        deskLabel={
          profile.role === "admin" ? "Admin dashboard" : "Volunteer desk"
        }
        autoPrint={autoPrint}
      />
    </main>
  );
}
