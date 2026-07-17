import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { PrintActions } from "@/components/print-actions";
import { QrCard } from "@/components/qr-card";
import { headers } from "next/headers";

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
      <main className="p-6">
        <p>Patient not found.</p>
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
    <main className="mx-auto max-w-3xl px-4 py-6">
      <PrintActions className="no-print mb-4" />

      <article className="print-sheet rounded-xl border-2 border-[#1a3a8a] bg-white p-6 text-[#1a3a8a]">
        <header className="border-b-2 border-[#1a3a8a] pb-3 text-center">
          <p className="text-lg font-bold tracking-wide">
            SIKAR NAGARIK PARISHAD (KOLKATA)
          </p>
          <p className="text-sm font-semibold">SIKAR ZILLA WELFARE TRUST</p>
          <p className="mt-1 text-[10px] leading-snug">
            &apos;SIKAR BHAWAN&apos; 1A, ASHUTOSH DEY LANE, KOLKATA-6 · Ph: 033 4006
            4713 · Whatsapp: 86971 90268
          </p>
          <p className="mt-2 text-xs font-bold uppercase">
            Free eye screening, spectacles, medicines &amp; cataract (IOL) arrangement
          </p>
        </header>

        <div className="mt-4 grid grid-cols-[1fr_auto] gap-4 text-sm">
          <div className="space-y-2">
            <Field
              label="Venue"
              value={camp?.venue || camp?.name || "SIKAR BHAWAN"}
            />
            <Field label="Name" value={patient.full_name} />
            <Field label="Address" value={patient.address || ""} />
            <Field label="E-mail" value={patient.email || ""} />
            <Field label="Contact No." value={patient.phone || ""} />
          </div>
          <div className="w-40 space-y-2 text-right">
            <p>
              <span className="font-semibold">Reg. No.</span>
              <span className="ml-2 text-xl font-bold">{patient.reg_no}</span>
            </p>
            <p>
              <span className="font-semibold">Date</span> {today}
            </p>
            <p>
              <span className="font-semibold">Age</span> {patient.age ?? "—"}{" "}
              <span className="ml-2 font-semibold">
                {patient.gender === "M"
                  ? "M"
                  : patient.gender === "F"
                    ? "F"
                    : "M / F"}
              </span>
            </p>
            <div className="flex justify-end pt-1">
              <div className="origin-top-right scale-90 print:scale-100">
                <QrCard
                  value={`${origin}/print/${patient.id}`}
                  regNo={patient.reg_no}
                  patientId={patient.id}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-2 text-sm">
          <p className="font-semibold">Diagnosis:</p>
          <div className="flex flex-wrap gap-4">
            <Check label="RE - CATARACT" />
            <Check label="LE - CATARACT" />
            <Check label="REFRACTION" />
            <Check label="MEDICINE" />
          </div>
          <Field label="Blood Sugar (Random)" value="" />
          <Field label="BP" value="" />
          <Field label="Remarks" value="" />
          <Field label="Medicines" value="" />
          <Field label="Operation will be done at" value="" />
        </div>

        <div className="mt-4">
          <p className="mb-1 text-center text-xs font-bold uppercase tracking-wide">
            Prescription for glasses
          </p>
          <table className="w-full border-collapse border border-[#1a3a8a] text-center text-xs">
            <thead>
              <tr>
                <th className="border border-[#1a3a8a] p-1" rowSpan={2} />
                <th className="border border-[#1a3a8a] p-1" colSpan={4}>
                  RE
                </th>
                <th className="border border-[#1a3a8a] p-1" colSpan={4}>
                  LE
                </th>
              </tr>
              <tr>
                {["Dsph", "Dcyl", "Axis", "Vision", "Dsph", "Dcyl", "Axis", "Vision"].map(
                  (h, i) => (
                    <th key={`${h}-${i}`} className="border border-[#1a3a8a] p-1">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {["Distance", "Near"].map((row) => (
                <tr key={row}>
                  <td className="border border-[#1a3a8a] p-2 font-semibold">{row}</td>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <td key={i} className="border border-[#1a3a8a] p-2">
                      &nbsp;
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs">Inter Pupillary distance ………… mm</p>
        </div>

        <footer className="mt-6 flex items-end justify-between text-xs">
          <div>
            <p className="font-bold">Sponsorer:</p>
            <p>RUPA FOUNDATION, KOLKATA</p>
          </div>
          <p className="text-right">
            Signature of
            <br />
            Optometrist / Eye Surgeon
            <br />
            ________________
          </p>
        </footer>
      </article>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <p className="border-b border-dotted border-[#1a3a8a]/pb-0.5">
      <span className="font-semibold">{label}: </span>
      <span className="text-black">{value || "\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0"}</span>
    </p>
  );
}

function Check({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-3 w-3 border border-[#1a3a8a]" />
      {label}
    </span>
  );
}
