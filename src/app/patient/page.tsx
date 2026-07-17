import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import {
  formatCampDay,
  queueLabel,
  queueTone,
  type CampDayStats,
} from "@/lib/types";
import { Badge, Card, NavLink, Shell } from "@/components/ui";
import { QrCard } from "@/components/qr-card";
import { SignOutButton } from "@/components/sign-out";
import { ChangeDay } from "@/components/change-day";
import { SeatBoard } from "@/components/seat-board";
import { patientScanUrl } from "@/lib/qr";

export default async function PatientHomePage() {
  const { userId, profile } = await getSessionProfile();
  if (!userId) redirect("/patient/login");

  const supabase = await createClient();
  const { data: patient } = await supabase
    .from("patients")
    .select(
      "id, reg_no, full_name, queue_status, gender, age, phone, address, aadhaar_last4, camp_id, camp_day_id, camp_days(day_date)",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const campId = (patient?.camp_id as string | undefined) || null;
  const { data: dayStats } = campId
    ? await supabase.rpc("camp_day_stats", { p_camp_id: campId })
    : { data: [] as CampDayStats[] };
  const days = (dayStats as CampDayStats[]) || [];

  const dayRel = patient?.camp_days as
    | { day_date: string }
    | { day_date: string }[]
    | null
    | undefined;
  const dayDate = Array.isArray(dayRel)
    ? dayRel[0]?.day_date
    : dayRel?.day_date;

  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const origin = process.env.NEXT_PUBLIC_SITE_URL || `${proto}://${host}`;

  return (
    <Shell
      title="My profile"
      subtitle="Your camp registration"
      backHref="/"
      width="lg"
    >
      <div className="space-y-4">
        {!patient ? (
          <Card>
            <p className="mb-1 font-semibold">No registration linked yet</p>
            <p className="mb-4 text-sm text-muted">
              Register for a camp day with open seats to get your reg number.
            </p>
            <NavLink href="/register">Register now</NavLink>
            {days.length ? (
              <div className="mt-4">
                <SeatBoard days={days} title="Available days" compact />
              </div>
            ) : null}
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            <div className="space-y-4">
              <Card className="bg-gradient-to-br from-brand-soft/70 to-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xl font-bold tracking-tight">
                      {patient.full_name}
                    </p>
                    <p className="mt-0.5 text-sm text-muted">
                      {[
                        dayDate ? formatCampDay(dayDate) : null,
                        patient.gender,
                        patient.age ? `${patient.age} yrs` : null,
                        patient.phone,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {patient.aadhaar_last4 ? (
                      <p className="mt-1 text-xs text-muted">
                        Aadhaar ···· {patient.aadhaar_last4}
                      </p>
                    ) : null}
                  </div>
                  <Badge tone={queueTone(patient.queue_status)}>
                    {queueLabel(patient.queue_status)}
                  </Badge>
                </div>
              </Card>
              {isStaff(profile?.role) ? (
                <NavLink href={`/print/${patient.id}`} variant="soft">
                  Open print form (join queue)
                </NavLink>
              ) : (
                <QrCard
                  value={patientScanUrl(patient.id, origin)}
                  regNo={patient.reg_no}
                  patientId={patient.id}
                />
              )}
              <p className="text-center text-xs text-muted">
                {patient.queue_status === "registered"
                  ? "Not in queue until staff prints your prescription."
                  : patient.queue_status === "waiting"
                    ? "In queue — waiting for doctor scan."
                    : "Seen by a doctor."}
              </p>
            </div>
            <div className="space-y-4">
              <Card>
                <p className="mb-2 text-sm font-semibold">Camp day</p>
                <p className="mb-3 text-xs text-muted">
                  {patient.queue_status === "waiting" ||
                  patient.queue_status === "seen"
                    ? "Your day is fixed once you are in the queue."
                    : "One day per registration. You can switch while seats remain, until you join the queue."}
                </p>
                <ChangeDay
                  patientId={patient.id}
                  currentDayId={patient.camp_day_id}
                  days={days}
                  queueStatus={patient.queue_status}
                />
              </Card>
              <SeatBoard days={days} title="Seat availability" compact />
            </div>
          </div>
        )}
        <SignOutButton />
      </div>
    </Shell>
  );
}
