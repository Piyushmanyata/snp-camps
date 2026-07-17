import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import type { CampDayStats } from "@/lib/types";
import { Card, EmptyState, Shell, StepList } from "@/components/ui";
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
    : { data: [] as CampDayStats[] };
  const days = (dayStats as CampDayStats[]) || [];
  const staff = isStaff(profile?.role);

  return (
    <Shell
      title="Register patient"
      subtitle="Choose a day with open seats"
      backHref={
        profile?.role === "admin"
          ? "/admin"
          : staff
            ? "/volunteer"
            : "/"
      }
      width="lg"
      roleLabel={staff ? "Staff" : undefined}
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
        <div className="grid gap-4 lg:grid-cols-5 lg:items-start">
          <div className="space-y-4 lg:col-span-2">
            <Card className="bg-gradient-to-br from-brand-soft/60 to-card">
              <p className="text-[11px] font-bold uppercase tracking-wide text-brand">
                Active camp
              </p>
              <p className="text-lg font-bold tracking-tight">{camp.name}</p>
              <p className="text-sm text-muted">
                {camp.venue || "Walk-in registration"}
              </p>
            </Card>
            <SeatBoard days={days} title="Seat availability" compact />
            <Card padding="sm" className="hidden bg-background/50 sm:block">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted">
                After you register
              </p>
              <StepList
                steps={
                  staff
                    ? [
                        { title: "Save", detail: "Gets a reg number" },
                        { title: "Print", detail: "Optional · joins queue" },
                        { title: "Scan", detail: "Doctor marks seen" },
                      ]
                    : [
                        { title: "Aadhaar", detail: "Verify 12-digit number" },
                        { title: "Sign in", detail: "Reg no + password shown" },
                        { title: "Doctor", detail: "Scan when you are seen" },
                      ]
                }
              />
            </Card>
          </div>

          <Card className="lg:col-span-3">
            <p className="prose-help mb-4 text-sm text-muted">
              {staff
                ? "One person, one day. After save they are registered. Print joins the live queue (optional). Doctors can scan registered patients without printing."
                : "Self-registration is Aadhaar-only. After verify you get a reg number and password, are signed in, and receive SMS/WhatsApp when those are configured."}
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
        </div>
      )}
    </Shell>
  );
}
