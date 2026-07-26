import { connection } from "next/server";
import { notFound } from "next/navigation";
import { formatCampDay } from "@/lib/format-camp-day";
import { isStatusTokenFormat } from "@/lib/status-token";
import { createServiceRoleClient } from "@/lib/supabase/admin";

/**
 * Passwordless patient status — zero client JS (Server Component only).
 * Unknown / malformed tokens → same plain not-found (no oracle).
 */
export default async function PatientStatusPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await connection();
  const { token: raw } = await params;
  const token = raw.trim().toLowerCase();
  if (!isStatusTokenFormat(token)) notFound();

  const admin = createServiceRoleClient();
  if (!admin) notFound();

  const { data: patient, error } = await admin
    .from("patients")
    .select(
      "full_name, reg_no, queue_status, queued_at, camp_id, camps(name, venue), camp_days(day_date)",
    )
    .eq("status_token", token)
    .maybeSingle();

  if (error || !patient) notFound();

  const camp = Array.isArray(patient.camps) ? patient.camps[0] : patient.camps;
  const day = Array.isArray(patient.camp_days)
    ? patient.camp_days[0]
    : patient.camp_days;
  const dayDate =
    day && typeof day === "object" && "day_date" in day
      ? String((day as { day_date: string }).day_date)
      : null;
  const campName =
    camp && typeof camp === "object" && "name" in camp
      ? String((camp as { name: string }).name)
      : "—";
  const venue =
    camp && typeof camp === "object" && "venue" in camp
      ? ((camp as { venue: string | null }).venue ?? "—")
      : "—";

  let queuePosition: number | null = null;
  if (patient.queue_status === "waiting" && patient.queued_at) {
    const { count } = await admin
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("camp_id", patient.camp_id)
      .eq("queue_status", "waiting")
      .lte("queued_at", patient.queued_at);
    queuePosition = count ?? null;
  }

  return (
    <main id="main" className="mx-auto max-w-md px-4 py-10 text-foreground">
      <h1 className="text-xl font-bold tracking-tight">Camp status</h1>
      <dl className="mt-6 space-y-4 text-[1.0625rem]">
        <div>
          <dt className="text-sm font-medium text-muted">Name</dt>
          <dd className="font-semibold">{patient.full_name}</dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-muted">Registration number</dt>
          <dd className="font-semibold tabular">#{patient.reg_no}</dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-muted">Camp</dt>
          <dd className="font-semibold">{campName}</dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-muted">Date</dt>
          <dd className="font-semibold">
            {dayDate ? formatCampDay(dayDate) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-muted">Venue</dt>
          <dd className="font-semibold">{venue}</dd>
        </div>
        {queuePosition != null ? (
          <div>
            <dt className="text-sm font-medium text-muted">Queue position</dt>
            <dd className="font-semibold tabular">{queuePosition}</dd>
          </div>
        ) : null}
      </dl>
    </main>
  );
}
