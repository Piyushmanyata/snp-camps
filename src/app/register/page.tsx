import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import type { CampDayStats } from "@/lib/types";
import { Card, EmptyState, Shell } from "@/components/ui";
import { PatientForm } from "@/components/patient-form";
import { SeatBoard } from "@/components/seat-board";
import { SignOutButton } from "@/components/sign-out";

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
    : { data: [] as CampDayStats[] };
  const days = (dayStats as CampDayStats[]) || [];
  const staff = isStaff(profile?.role);
  const role = profile?.role;

  const deskHref =
    role === "volunteer"
      ? "/volunteer"
      : role === "doctor"
        ? "/doctor"
        : role === "admin"
          ? "/admin"
          : "/";

  const staffDock =
    role === "volunteer"
      ? [
          { href: "/register", label: "Register", primary: true as const },
          { href: "/volunteer", label: "Desk" },
          { href: "/volunteer#scan", label: "Scan" },
        ]
      : role === "admin"
        ? [
            { href: "/register", label: "Register", primary: true as const },
            { href: "/admin", label: "Admin" },
            { href: "/admin/patients", label: "Patients" },
          ]
        : role === "doctor"
          ? [
              { href: "/register", label: "Register", primary: true as const },
              { href: "/doctor", label: "Desk" },
            ]
          : undefined;

  return (
    <Shell
      title={staff ? "Register walk-in" : "Register patient"}
      subtitle={
        staff
          ? "Desk registration · phone required · no OTP"
          : "Phone OTP · choose a day with open seats"
      }
      backHref={staff ? deskHref : "/"}
      width="lg"
      roleLabel={
        staff
          ? role === "admin"
            ? "Admin"
            : role === "doctor"
              ? "Doctor"
              : "Volunteer"
          : undefined
      }
      actions={staff ? <SignOutButton place="header" /> : undefined}
      dock={staff ? staffDock : undefined}
    >
      {!camp ? (
        <Card>
          <EmptyState>
            No active camp. Ask admin to create or activate a camp first.
          </EmptyState>
          {profile?.role === "admin" ? (
            <Link
              href="/admin"
              className="mt-3 inline-flex text-sm font-semibold text-brand underline decoration-brand/30 underline-offset-2"
            >
              Go to admin
            </Link>
          ) : null}
        </Card>
      ) : (
        <div className="grid gap-3 sm:gap-4 lg:grid-cols-5 lg:items-start">
          {/* Form first on phone — speed for walk-ins */}
          <Card className="order-1 !p-4 sm:!p-5 lg:order-2 lg:col-span-3">
            <p className="prose-help mb-3 text-sm text-muted sm:mb-4">
              {staff
                ? "One person, one day. Save → registered. Print joins the FCFS queue (optional). Doctors can scan without printing."
                : "Self-registration uses phone OTP. After verify you complete details, get a reg number, and stay signed in."}
            </p>
            <PatientForm
              campId={camp.id}
              days={days}
              userId={profile?.role === "patient" ? userId : null}
              createdBy={staff ? userId : null}
              isStaff={staff}
              defaultPhone={profile?.phone || ""}
            />
          </Card>

          <div className="order-2 space-y-3 sm:space-y-4 lg:order-1 lg:col-span-2">
            <Card className="bg-gradient-to-br from-brand-soft/60 to-card !p-4 sm:!p-5">
              <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand sm:text-[11px]">
                Active camp
              </p>
              <p className="text-base font-bold tracking-tight sm:text-lg">
                {camp.name}
              </p>
              <p className="text-sm text-muted">
                {camp.venue || "Walk-in registration"}
              </p>
            </Card>
            <SeatBoard
              days={days}
              campId={camp.id}
              title="Seat board"
              compact
              pollMs={0}
            />
          </div>
        </div>
      )}
    </Shell>
  );
}
