import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { canRegisterPatients, getSessionProfile } from "@/lib/auth";
import { parseA4BatchIdsParam } from "@/lib/a4-batch-queue";
import { loadPrintSlips } from "@/lib/print-slip-load";
import { BatchClientBootstrap } from "@/components/batch-client-bootstrap";

const DeskSlipPrint = dynamic(
  () =>
    import("@/components/desk-slip-print").then((m) => ({
      default: m.DeskSlipPrint,
    })),
);

/**
 * A4 multi-up batch sheet (#64).
 * Loads distinct patients by id query param (station queue stores only ids).
 * Unauthorized/missing ids are omitted — never filled with duplicates.
 */
export default async function PrintBatchPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string; auto?: string }>;
}) {
  const query = await searchParams;
  const autoPrint = query.auto === "1" || query.auto === "true";
  const { profile } = await getSessionProfile();
  if (!profile) redirect("/login");
  if (!canRegisterPatients(profile.role)) {
    redirect(profile.role === "doctor" ? "/doctor" : "/");
  }

  const idsFromQuery = parseA4BatchIdsParam(query.ids);
  const supabase = await createClient();
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const origin = process.env.NEXT_PUBLIC_SITE_URL || `${proto}://${host}`;

  // When ids query present, load server-side. Empty query → client bootstrap
  // recovers from station localStorage (reload recovery).
  const loaded =
    idsFromQuery.length > 0
      ? await loadPrintSlips(supabase, idsFromQuery, origin)
      : [];

  const deskHref = profile.role === "admin" ? "/admin" : "/volunteer";
  const deskLabel =
    profile.role === "admin" ? "Admin dashboard" : "Volunteer desk";

  if (idsFromQuery.length === 0) {
    return (
      <main id="main" className="mx-auto max-w-[220mm] px-3 py-4 sm:px-4 sm:py-6">
        <BatchClientBootstrap deskHref={deskHref} deskLabel={deskLabel} />
      </main>
    );
  }

  if (loaded.length === 0) {
    return (
      <main id="main" className="mx-auto max-w-lg px-4 py-10">
        <div className="rounded-2xl border border-border bg-card p-6 text-center">
          <p className="text-lg font-semibold">No printable patients</p>
          <p className="mt-1 text-sm text-muted">
            Batch ids were missing, stale, or not visible for this camp. Clear
            the station batch and re-register, or open a single print link.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto max-w-[220mm] px-3 py-4 sm:px-4 sm:py-6">
      <DeskSlipPrint
        slips={loaded.map((s) => ({
          patient: s.patient,
          camp: s.camp,
          campDayDate: s.campDayDate,
          qrValue: s.qrValue,
          queueStatus: s.queueStatus,
        }))}
        deskHref={deskHref}
        deskLabel={deskLabel}
        autoPrint={autoPrint}
        isBatch
      />
    </main>
  );
}
