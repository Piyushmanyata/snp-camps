import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { PrintActions } from "@/components/print-actions";
import { PrintSheet } from "@/components/print-sheet";
import { patientScanUrl } from "@/lib/qr";

export default async function PrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ auto?: string }>;
}) {
  const { id } = await params;
  const { auto } = await searchParams;
  const { profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) redirect("/login");

  const uuidOk =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id,
    );

  if (!uuidOk) {
    return (
      <main className="mx-auto max-w-lg px-4 py-10">
        <div className="rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
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
      "id, reg_no, full_name, gender, age, address, phone, email, queue_status, camps(name, venue, camp_date)",
    )
    .eq("id", id)
    .maybeSingle();

  if (patientErr || !patient) {
    return (
      <main className="mx-auto max-w-lg px-4 py-10">
        <div className="rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
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

  // Print path: join FCFS queue only — never mark seen. Idempotent if already waiting.
  if (patient.queue_status === "registered" || patient.queue_status === "waiting") {
    const { error: queueErr } = await supabase.rpc("mark_patient_printed", {
      p_id: id,
    });
    if (queueErr) {
      return (
        <main className="mx-auto max-w-lg px-4 py-10">
          <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center shadow-sm">
            <p className="text-lg font-semibold text-red-950">Could not join queue</p>
            <p className="mt-1 text-sm text-red-900">
              {queueErr.message || "Try again or ask an admin."}
            </p>
          </div>
        </main>
      );
    }
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

  const today = new Date().toLocaleDateString("en-IN");

  return (
    <main className="mx-auto max-w-[220mm] px-3 py-4 sm:px-4 sm:py-6">
      <PrintActions
        className="no-print mb-4"
        regNo={patient.reg_no}
        name={patient.full_name}
        autoPrint={auto === "1" || auto === "true"}
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
        origin={origin}
        today={today}
        qrValue={patientScanUrl(patient.id, origin)}
      />

      <p className="no-print mt-3 text-center text-xs text-muted">
        Fits one A4 page · Portrait · QR is for <strong>staff scan only</strong>{" "}
        (not login). Patient is <strong>in queue</strong> until a volunteer or
        doctor scans and marks seen.
      </p>
    </main>
  );
}
