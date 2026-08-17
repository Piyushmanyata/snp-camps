import { notFound, redirect } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { getSessionProfile, roleHome } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { patientScanUrl } from "@/lib/qr";
import { AutoPrint } from "@/components/auto-print";
import { PrintSlipButton } from "@/components/print-slip-button";
import { formatCampDaySms } from "@/lib/format-camp-day";

type Slip = {
  id: string;
  reference: string;
  version: number;
  service: "specs" | "ot";
  date: string;
  venue: string;
  issued_at: string;
  patient_id: string;
  reg_no: number;
  name: string;
  age: number | null;
  gender: string | null;
  camp_name: string;
};

const GENDER_DEVANAGARI: Record<string, string> = {
  M: "पुरुष",
  F: "महिला",
  O: "अन्य",
};

export default async function ClinicalSlipPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { profile } = await getSessionProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "clinical_operator" && profile.role !== "admin") {
    redirect(roleHome(profile.role) || "/");
  }
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("clinical_slip_by_id", {
    p_slip_id: id,
  });
  if (error || !data) notFound();
  const slip = data as Slip;
  const dateLabel = formatCampDaySms(String(slip.date).slice(0, 10));
  return (
    <main
      id="main"
      className="slip mx-auto bg-white p-[3mm] text-black"
      data-print-format="clinical-slip-2-inch"
      data-page-width-mm="58"
    >
      <style>{`
        @font-face{
          font-family:SlipDevanagari;
          src:url("/fonts/slip-devanagari.woff2") format("woff2");
          font-display:block;
          unicode-range:U+0900-097F;
        }
        .slip{width:58mm;font-family:SlipDevanagari,Arial,sans-serif}
        @page{size:58mm auto;margin:2mm}
        @media print{body{margin:0}.slip{width:54mm;padding:0}}
      `}</style>
      <p className="text-center text-[9pt] font-bold">{slip.camp_name}</p>
      <h1 className="my-2 border-y-2 border-black py-1 text-center text-[18pt] font-black">
        {slip.service === "specs" ? "चश्मा" : "ऑपरेशन"}
      </h1>
      <dl className="space-y-1 text-[10pt]">
        <div><dt className="font-bold">नाम</dt><dd>{slip.name}</dd></div>
        <div className="flex gap-4">
          <div><dt className="font-bold">पंजी.</dt><dd>#{slip.reg_no}</dd></div>
          <div><dt className="font-bold">उम्र/लिंग</dt><dd>{slip.age ?? "—"} / {GENDER_DEVANAGARI[slip.gender ?? ""] ?? "—"}</dd></div>
        </div>
        <div><dt className="font-bold">तारीख</dt><dd>{dateLabel}</dd></div>
        <div><dt className="font-bold">स्थान</dt><dd className="break-words">{slip.venue}</dd></div>
      </dl>
      <div className="my-2 flex justify-center">
        <QRCodeSVG value={patientScanUrl(slip.patient_id)} size={112} level="M" />
      </div>
      <p className="text-center text-[8pt]">
        {slip.reference} · v{slip.version}<br />
        जारी{" "}
        {new Date(slip.issued_at).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          dateStyle: "short",
          timeStyle: "short",
        })}
      </p>
      <AutoPrint />
      <PrintSlipButton />
    </main>
  );
}
