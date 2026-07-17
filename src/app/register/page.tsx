import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import type { CampDayStats } from "@/lib/types";
import { Card, EmptyState, Shell } from "@/components/ui";
import { PatientForm } from "@/components/patient-form";
import { SeatBoard } from "@/components/seat-board";

export default async function RegisterPage() {
  const supabase = await createClient();
  const { userId, profile } = await getSessionProfile();

  const { data: camp } = await supabase
    .from("camps")
    .select("id, name, venue, camp_date")
    .eq("is_active", true)
    .maybeSingle();

  const { data: dayStats } = camp
    ? await supabase.rpc("camp_day_stats", { p_camp_id: camp.id })
    : { data: [] };
  const days = (dayStats as CampDayStats[]) || [];

  return (
    <Shell
      title="Register patient"
      subtitle="Choose a day with open seats"
      backHref={
        profile?.role === "admin"
          ? "/admin"
          : isStaff(profile?.role)
            ? "/volunteer"
            : "/"
      }
    >
      {!camp ? (
        <Card>
          <EmptyState>
            No active camp. Ask admin to create or activate a camp first.
          </EmptyState>
          {profile?.role === "admin" ? (
            <Link
              href="/admin"
              className="mt-3 inline-flex text-sm font-semibold text-brand underline"
            >
              Go to admin
            </Link>
          ) : null}
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="bg-gradient-to-br from-brand-soft/60 to-card">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand">
              Active camp
            </p>
            <p className="text-lg font-bold tracking-tight">{camp.name}</p>
            <p className="text-sm text-muted">
              {camp.venue || "Walk-in registration"}
            </p>
          </Card>

          <SeatBoard days={days} title="Seat availability" compact />

          <Card>
            <p className="mb-4 text-sm text-muted">
              One person can register for one day only. Full days stay listed
              but closed. After register, a volunteer must scan QR / reg no to
              add them to the live queue.
            </p>
            <PatientForm
              campId={camp.id}
              days={days}
              userId={profile?.role === "patient" ? userId : null}
              createdBy={isStaff(profile?.role) ? userId : null}
              defaultPhone={profile?.phone || ""}
            />
          </Card>
        </div>
      )}
    </Shell>
  );
}
