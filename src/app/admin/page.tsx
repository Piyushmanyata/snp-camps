import { Suspense } from "react";
import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import type { CampDayStats, Camp } from "@/lib/types";
import {
  Card,
  CollapsibleSection,
  NavLink,
  SectionTitle,
  Shell,
  Stat,
} from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import type { LiveQueuePatient } from "@/components/live-queue";
import { getCampsList, getDoctorsList } from "@/lib/metadata";

const SeatBoard = dynamic(
  () =>
    import("@/components/seat-board").then((m) => ({ default: m.SeatBoard })),
  {
    loading: () => <p className="py-4 text-xs text-muted">Loading seat board…</p>,
  },
);

const LiveQueue = dynamic(
  () =>
    import("@/components/live-queue").then((m) => ({ default: m.LiveQueue })),
  {
    loading: () => <p className="py-4 text-xs text-muted">Loading queue…</p>,
  },
);

const AdminCamps = dynamic(
  () => import("@/components/admin-camps").then((m) => ({ default: m.AdminCamps })),
  {
    loading: () => <p className="py-4 text-xs text-muted">Loading camps…</p>,
  },
);

const AdminCampDays = dynamic(
  () =>
    import("@/components/admin-camp-days").then((m) => ({
      default: m.AdminCampDays,
    })),
  {
    loading: () => <p className="py-4 text-xs text-muted">Loading camp days…</p>,
  },
);

async function AdminHeaderStats({ campId }: { campId: string | null }) {
  if (!campId) {
    return (
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <Stat label="Registered" value={0} />
        <Stat label="In queue" value={0} tone="wait" />
        <Stat label="Doctor seen" value={0} tone="ok" />
      </div>
    );
  }
  const supabase = await createClient();
  const { data: queueCountsRes, error } = await supabase.rpc(
    "camp_queue_counts",
    { p_camp_id: campId },
  );
  if (error) throw new Error("Admin queue counts could not be loaded");
  const queueCounts = Array.isArray(queueCountsRes)
    ? queueCountsRes[0]
    : queueCountsRes;
  const registered = Number(queueCounts?.registered_count ?? 0);
  const inQueue = Number(queueCounts?.waiting_count ?? 0);
  const doctorSeen = Number(queueCounts?.seen_count ?? 0);

  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-3">
      <Stat label="Registered" value={registered} />
      <Stat label="In queue" value={inQueue} tone="wait" />
      <Stat label="Doctor seen" value={doctorSeen} tone="ok" />
    </div>
  );
}

async function ActiveCampAvgWait({ campId }: { campId: string }) {
  const supabase = await createClient();
  const { data: queueCountsRes } = await supabase.rpc("camp_queue_counts", {
    p_camp_id: campId,
  });
  const queueCounts = Array.isArray(queueCountsRes)
    ? queueCountsRes[0]
    : queueCountsRes;
  const avgWaitMin =
    queueCounts?.avg_wait_minutes != null
      ? Number(queueCounts.avg_wait_minutes)
      : null;
  if (avgWaitMin == null || Number.isNaN(avgWaitMin)) return null;
  return (
    <p className="mt-2 text-[0.8125rem] text-muted">
      Avg wait (queued → doctor seen):{" "}
      <span className="font-semibold tabular text-foreground">
        {avgWaitMin < 1 ? "< 1 min" : `${Math.round(avgWaitMin)} min`}
      </span>
    </p>
  );
}

async function AdminSeatBoardSection({
  camps,
  active,
}: {
  camps: Camp[];
  active?: Camp;
}) {
  if (!active) {
    return (
      <CollapsibleSection
        title="Camps"
        hint={`${camps.length} total`}
        defaultOpen
      >
        <AdminCamps camps={camps} />
      </CollapsibleSection>
    );
  }

  const supabase = await createClient();
  const { data: dayStatsRes, error } = await supabase.rpc("camp_day_stats", {
    p_camp_id: active.id,
  });
  if (error) throw new Error("Admin day stats could not be loaded");
  const days = (dayStatsRes as CampDayStats[]) || [];

  return (
    <div className="space-y-3">
      <SeatBoard days={days} campId={active.id} title="Seat board" pollMs={0} />
      <CollapsibleSection
        title="Camps & camp days"
        hint={`${camps.length} camp${camps.length === 1 ? "" : "s"} · ${days.length} day${days.length === 1 ? "" : "s"}`}
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
            <AdminCamps camps={camps} />
          </div>
        </div>
      </CollapsibleSection>
    </div>
  );
}

async function AdminQueueSection({ campId }: { campId: string }) {
  const supabase = await createClient();
  const [waitingRes, doctors] = await Promise.all([
    supabase
      .from("patients")
      .select("id, reg_no, full_name, phone, queued_at", {
        count: "exact",
      })
      .eq("camp_id", campId)
      .eq("queue_status", "waiting")
      .order("queued_at", { ascending: true, nullsFirst: false })
      .limit(100),
    getDoctorsList(),
  ]);

  if (waitingRes.error) {
    throw new Error("Admin queue data could not be loaded");
  }

  const waiting = (waitingRes.data || []) as LiveQueuePatient[];
  const waitingCount = waitingRes.count ?? waiting.length;

  return (
    <Card padding="sm" id="queue">
      <div className="px-1 pt-1">
        <SectionTitle hint="FCFS · assign doctor · auto-refresh">
          Queue
        </SectionTitle>
      </div>
      <LiveQueue
        initial={waiting}
        initialTotal={waitingCount}
        campId={campId}
        doctors={doctors}
        mode="admin"
      />
    </Card>
  );
}

export default async function AdminPage() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") redirect("/login");

  const camps = await getCampsList();

  const active = camps?.find((c) => c.is_active);

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
        <Suspense
          fallback={
            <div className="grid grid-cols-3 gap-2 sm:gap-3 opacity-60">
              <Stat label="Registered" value="…" />
              <Stat label="In queue" value="…" tone="wait" />
              <Stat label="Doctor seen" value="…" tone="ok" />
            </div>
          }
        >
          <AdminHeaderStats campId={active?.id ?? null} />
        </Suspense>

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
          {active ? (
            <Suspense fallback={null}>
              <ActiveCampAvgWait campId={active.id} />
            </Suspense>
          ) : null}
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

        <Suspense
          fallback={
            <Card className="p-6 text-sm text-muted">
              Loading seat board & camp days…
            </Card>
          }
        >
          <AdminSeatBoardSection camps={camps || []} active={active} />
        </Suspense>

        {active ? (
          <Suspense
            fallback={
              <Card className="p-6 text-sm text-muted">Loading queue…</Card>
            }
          >
            <AdminQueueSection campId={active.id} />
          </Suspense>
        ) : null}
      </div>
    </Shell>
  );
}
