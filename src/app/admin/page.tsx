import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import type { CampDayStats } from "@/lib/types";
import {
  Card,
  CollapsibleSection,
  NavLink,
  SectionTitle,
  Shell,
  Stat,
} from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import { AdminCamps } from "@/components/admin-camps";
import { AdminCampDays } from "@/components/admin-camp-days";
import { SeatBoard } from "@/components/seat-board";
import { LiveQueue, type LiveQueuePatient } from "@/components/live-queue";
import type { DoctorOption } from "@/components/qr-scanner";

export default async function AdminPage() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") redirect("/login");

  const supabase = await createClient();

  const { data: camps, error: campError } = await supabase
    .from("camps")
    .select("id, name, venue, camp_date, is_active, created_at")
    .order("created_at", { ascending: false });

  const active = camps?.find((c) => c.is_active);

  const [dayStatsRes, queueCountsRes, waitingRes, doctorsRes] =
    await Promise.all([
      active
        ? supabase.rpc("camp_day_stats", { p_camp_id: active.id })
        : Promise.resolve({ data: [] as CampDayStats[] }),
      active
        ? supabase.rpc("camp_queue_counts", { p_camp_id: active.id })
        : Promise.resolve({ data: [] }),
      active
        ? supabase
            .from("patients")
            .select("id, reg_no, full_name, phone, queued_at", {
              count: "exact",
            })
            .eq("camp_id", active.id)
            .eq("queue_status", "waiting")
            .order("queued_at", { ascending: true, nullsFirst: false })
            .limit(100)
        : Promise.resolve({ data: [] as LiveQueuePatient[], count: 0 }),
      supabase
        .from("profiles")
        .select("id, full_name")
        .eq("role", "doctor")
        .order("full_name", { ascending: true }),
    ]);

  if (
    Boolean(campError) ||
    [queueCountsRes, waitingRes, doctorsRes].some(
      (result) => "error" in result && Boolean(result.error),
    ) ||
    (active && "error" in dayStatsRes && Boolean(dayStatsRes.error))
  ) {
    throw new Error("Admin data could not be loaded");
  }

  const days = (dayStatsRes.data as CampDayStats[]) || [];
  const waiting = (waitingRes.data || []) as LiveQueuePatient[];
  const waitingCount = waitingRes.count ?? waiting.length;
  const doctors = (doctorsRes.data || []) as DoctorOption[];

  const queueCounts = Array.isArray(queueCountsRes.data)
    ? queueCountsRes.data[0]
    : queueCountsRes.data;
  const registered = Number(queueCounts?.registered_count ?? 0);
  const inQueue = Number(queueCounts?.waiting_count ?? 0);
  const doctorSeen = Number(queueCounts?.seen_count ?? 0);
  const avgWaitMin =
    queueCounts?.avg_wait_minutes != null
      ? Number(queueCounts.avg_wait_minutes)
      : null;

  return (
    <Shell
      title="Admin"
      subtitle={profile?.full_name || "Camp control"}
      width="xl"
      roleLabel="Admin"
      actions={<SignOutButton place="header" />}
      dock={[
        { href: "/register", label: "Register", primary: true },
        { href: "/admin/patients", label: "Patients" },
        { href: "/volunteer", label: "Volunteers" },
        { href: "/doctor", label: "Doctors" },
      ]}
    >
      <div className="space-y-3 sm:space-y-4 lg:space-y-5">
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Stat label="Registered" value={registered} />
          <Stat label="In queue" value={inQueue} tone="wait" />
          <Stat label="Doctor seen" value={doctorSeen} tone="ok" />
        </div>

        <Card className="bg-gradient-to-br from-brand-soft/80 to-card !p-4 sm:!p-5">
          <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand sm:text-xs">
            Active camp
          </p>
          <p className="mt-0.5 text-lg font-bold tracking-tight sm:text-2xl">
            {active?.name || "None set"}
          </p>
          {active?.venue ? (
            <p className="text-sm text-muted sm:text-[0.9375rem]">
              {active.venue}
            </p>
          ) : null}
          {avgWaitMin != null && !Number.isNaN(avgWaitMin) ? (
            <p className="mt-2 text-[0.8125rem] text-muted">
              Avg wait (queued → doctor seen):{" "}
              <span className="font-semibold tabular text-foreground">
                {avgWaitMin < 1
                  ? "< 1 min"
                  : `${Math.round(avgWaitMin)} min`}
              </span>
            </p>
          ) : null}
          {/* Phone: primary paths always visible (desk-inline is desktop-only) */}
          <div className="mt-3 grid gap-2 lg:hidden">
            <NavLink href="/register" variant="primary">
              Register patient
            </NavLink>
            <div className="grid grid-cols-3 gap-2">
              <NavLink href="/admin/patients" variant="soft">
                Patients
              </NavLink>
              <NavLink href="/volunteer" variant="soft">
                Volunteers
              </NavLink>
              <NavLink href="/doctor" variant="soft">
                Doctors
              </NavLink>
            </div>
          </div>
          <div className="desk-inline-actions mt-4 gap-2.5 sm:grid-cols-2">
            <NavLink href="/register" variant="primary">
              Register patient
            </NavLink>
            <NavLink href="/volunteer" variant="soft">
              Volunteer desk
            </NavLink>
            <NavLink href="/doctor" variant="soft">
              Doctor desk
            </NavLink>
            <NavLink href="/admin/patients" variant="soft">
              Patient desk
            </NavLink>
          </div>
        </Card>

        {active ? (
          <div className="space-y-3">
            <SeatBoard days={days} campId={active.id} title="Seat board" pollMs={0} />
            <CollapsibleSection
              title="Camps & camp days"
              hint={`${camps?.length ?? 0} camp${(camps?.length ?? 0) === 1 ? "" : "s"} · ${days.length} day${days.length === 1 ? "" : "s"}`}
              defaultOpen={!days.length}
            >
              <div className="space-y-6">
                <div>
                  <p className="mb-2 text-sm font-semibold text-foreground">
                    Camp days — {active.name}
                  </p>
                  <AdminCampDays
                    campId={active.id}
                    campName={active.name}
                    initialDays={days}
                  />
                </div>
                <div className="border-t border-border pt-4">
                  <p className="mb-2 text-sm font-semibold text-foreground">
                    All camps
                  </p>
                  <AdminCamps camps={camps || []} />
                </div>
              </div>
            </CollapsibleSection>
          </div>
        ) : (
          <CollapsibleSection
            title="Camps"
            hint={`${camps?.length ?? 0} total`}
            defaultOpen
          >
            <AdminCamps camps={camps || []} />
          </CollapsibleSection>
        )}

        {active ? (
          <Card padding="sm" id="queue">
            <div className="px-1 pt-1">
              <SectionTitle hint="FCFS · assign doctor · auto-refresh">
                Queue
              </SectionTitle>
            </div>
            <LiveQueue
              initial={waiting}
              initialTotal={waitingCount}
              campId={active.id}
              doctors={doctors}
              mode="admin"
            />
          </Card>
        ) : null}
      </div>
    </Shell>
  );
}
