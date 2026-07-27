import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isCampCrew, getSessionProfile, roleHome } from "@/lib/auth";
import { isPatientUuid, patientScanUrl } from "@/lib/qr";
import { PrescriptionPrintSheet } from "@/components/prescription-print-sheet";

type PatientRow = {
  id: string;
  reg_no: number;
  full_name: string;
  age: number | null;
  gender: string | null;
  queue_status: string;
  camps:
    | { name: string; venue: string | null; camp_date: string | null }
    | { name: string; venue: string | null; camp_date: string | null }[]
    | null;
  camp_days: { day_date: string } | { day_date: string }[] | null;
};

type PrescriptionRow = {
  diagnosis: string | null;
  examination: string | null;
  medicines: string | null;
  advice: string | null;
  created_at: string;
};

function campFromRow(row: PatientRow) {
  const campRel = row.camps;
  return Array.isArray(campRel) ? campRel[0] ?? null : campRel;
}

function campDayFromRow(row: PatientRow): string | null {
  const dayRel = row.camp_days;
  if (Array.isArray(dayRel)) return dayRel[0]?.day_date ?? null;
  return dayRel?.day_date ?? null;
}

export default async function PrescriptionPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ auto?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const autoPrint = query.auto === "1" || query.auto === "true";

  // Access Control: Staff only (authenticated camp crew - admin, volunteer, doctor).
  // Refuse unauthenticated or patient status token requests.
  const { profile } = await getSessionProfile();
  if (!profile || !isCampCrew(profile.role)) {
    redirect("/login");
  }

  if (!isPatientUuid(id)) {
    return (
      <main id="main" className="mx-auto max-w-lg px-4 py-10">
        <div className="rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
          <p className="text-lg font-semibold text-foreground">Invalid patient link</p>
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

  const { data: rawPatient } = await supabase
    .from("patients")
    .select(
      "id, reg_no, full_name, age, gender, queue_status, camps(name, venue, camp_date), camp_days(day_date)",
    )
    .eq("id", id)
    .maybeSingle();

  const patient = rawPatient as PatientRow | null;

  if (!patient) {
    return (
      <main id="main" className="mx-auto max-w-lg px-4 py-10">
        <div className="rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
          <p className="text-lg font-semibold text-foreground">Patient not found</p>
          <p className="mt-1 text-sm text-muted">
            Check the QR or registration number and try again.
          </p>
        </div>
      </main>
    );
  }

  const { data: rawPrescription } = await supabase
    .from("prescriptions")
    .select("id, diagnosis, examination, medicines, advice, created_at")
    .eq("patient_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const prescription = rawPrescription as (PrescriptionRow & { id: string }) | null;

  let amendments: { id: string; author_name?: string | null; content: string; created_at: string }[] = [];
  if (prescription?.id) {
    const { data: rawAmendments } = await supabase
      .from("prescription_amendments")
      .select("id, content, created_at, profiles:author_id(full_name)")
      .eq("prescription_id", prescription.id)
      .order("created_at", { ascending: true });

    if (rawAmendments) {
      amendments = rawAmendments.map((a) => {
        const prof = Array.isArray(a.profiles) ? a.profiles[0] : a.profiles;
        return {
          id: a.id,
          author_name: prof?.full_name || "Doctor",
          content: a.content,
          created_at: a.created_at,
        };
      });
    }
  }

  const qrValue = patientScanUrl(patient.id, origin);
  const homePath = roleHome(profile.role) || "/doctor";
  const homeLabel =
    profile.role === "admin"
      ? "Admin dashboard"
      : profile.role === "volunteer"
        ? "Volunteer desk"
        : "Doctor dashboard";

  return (
    <main id="main" className="bg-background min-h-screen">
      <PrescriptionPrintSheet
        patient={{
          id: patient.id,
          reg_no: patient.reg_no,
          full_name: patient.full_name,
          age: patient.age,
          gender: patient.gender,
        }}
        camp={campFromRow(patient)}
        campDayDate={campDayFromRow(patient)}
        qrValue={qrValue}
        clinical={{
          diagnosis: prescription?.diagnosis,
          examination: prescription?.examination,
          medicines: prescription?.medicines,
          advice: prescription?.advice,
        }}
        amendments={amendments}
        deskHref={homePath}
        deskLabel={homeLabel}
        autoPrint={autoPrint}
      />
    </main>
  );
}
