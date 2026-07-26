import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { canRegisterPatients, getSessionProfile } from "@/lib/auth";
import { isPatientUuid, patientScanUrl } from "@/lib/qr";
import { PrintSheet } from "@/components/print-sheet";

const PrintActions = dynamic(
  () =>
    import("@/components/print-actions").then((m) => ({
      default: m.PrintActions,
    })),
);

export default async function PrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
      "id, reg_no, full_name, gender, age, address, phone, email, queue_status, camps(name, venue, camp_date), camp_days(day_date)",
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

  const today = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
  }).format(new Date());

  return (
    <main id="main" className="mx-auto max-w-[220mm] px-3 py-4 sm:px-4 sm:py-6">
      <PrintActions
        className="no-print mb-4"
        patientId={patient.id}
        regNo={patient.reg_no}
        name={patient.full_name}
        queueStatus={patient.queue_status}
        deskHref={profile.role === "admin" ? "/admin" : "/volunteer"}
        deskLabel={
          profile.role === "admin" ? "Admin dashboard" : "Volunteer desk"
        }
      />

      <PrintSheet
        patient={{
          id: patient.id,
          reg_no: patient.reg_no,
          full_name: patient.full_name,
          gender: patient.gender,
          age: patient.age,
          address: patient.address,
          phone: patient.phone,
          email: patient.email,
        }}
        camp={camp}
        campDayDate={campDayDate}
        origin={origin}
        today={today}
        qrValue={patientScanUrl(patient.id, origin)}
      />

      <p className="no-print mt-3 text-center text-xs text-muted">
        Fits one A4 page · Portrait · QR is for <strong>staff scan only</strong>
        . Status for the patient is a separate SMS link when configured.{" "}
        {patient.queue_status === "seen" ? (
          <>The consultation is complete; reprinting does not change its status.</>
        ) : patient.queue_status === "waiting" ? (
          <>The patient is in queue and waiting for a doctor.</>
        ) : (
          <>
            Use <strong>Join queue &amp; print</strong> before the patient proceeds
            to a doctor.
          </>
        )}
      </p>
    </main>
  );
}
