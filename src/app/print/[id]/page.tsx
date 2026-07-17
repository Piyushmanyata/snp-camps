import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { PrintActions } from "@/components/print-actions";
import { PrintSheet } from "@/components/print-sheet";

export default async function PrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) redirect("/login");

  const supabase = await createClient();
  await supabase.rpc("mark_patient_seen", { p_id: id });

  const { data: patient } = await supabase
    .from("patients")
    .select("*, camps(name, venue, camp_date)")
    .eq("id", id)
    .maybeSingle();

  if (!patient) {
    return (
      <main className="mx-auto max-w-lg px-4 py-10">
        <div className="rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
          <p className="text-lg font-semibold">Patient not found</p>
          <p className="mt-1 text-sm text-muted">
            Check the QR or registration number and try again.
          </p>
        </div>
      </main>
    );
  }

  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const origin = process.env.NEXT_PUBLIC_SITE_URL || `${proto}://${host}`;
  const camp = patient.camps as {
    name: string;
    venue: string | null;
    camp_date: string | null;
  } | null;

  const today = new Date().toLocaleDateString("en-IN");

  return (
    <main className="mx-auto max-w-[220mm] px-3 py-4 sm:px-4 sm:py-6">
      <PrintActions
        className="no-print mb-4"
        regNo={patient.reg_no}
        name={patient.full_name}
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
      />

      <p className="no-print mt-3 text-center text-xs text-muted">
        Fits one A4 page · Use browser Print → Portrait · Margins: Default or
        Minimum
      </p>
    </main>
  );
}
