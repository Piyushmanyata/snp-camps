import { Suspense } from "react";
import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Card, EmptyState, NavLink, Shell, Stat } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import type { AdminPatientRow } from "@/components/admin-patients";

const AdminPatients = dynamic(
  () =>
    import("@/components/admin-patients").then((m) => ({
      default: m.AdminPatients,
    })),
  {
    loading: () => (
      <p role="status" className="py-6 text-center text-sm text-muted">
        Loading patient desk…
      </p>
    ),
  },
);

async function PatientDeskContent() {
  const supabase = await createClient();

  const { data: camp, error: campError } = await supabase
    .from("camps")
    .select("id, name")
    .eq("is_active", true)
    .maybeSingle();

  const [patientsRes, queueCountsRes] = await Promise.all([
    supabase
      .from("patients")
      .select(
        "id, user_id, reg_no, full_name, phone, queue_status, gender, age, created_at, camp_id, camp_day_id, created_by, checked_in_by, seen_by, queued_at, seen_at, passcode_issued_at, camps(name), camp_days(day_date), volunteer:profiles!created_by(full_name), checked_in_by_profile:profiles!checked_in_by(full_name), doctor:profiles!seen_by(full_name)",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .limit(50),
    camp
      ? supabase.rpc("camp_queue_counts", { p_camp_id: camp.id })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (campError || patientsRes.error || (camp && queueCountsRes.error)) {
    throw new Error("Patient desk data could not be loaded");
  }

  const patients: AdminPatientRow[] = (patientsRes.data || []).map((p) => {
    const campRel = p.camps as { name: string } | { name: string }[] | null;
    const campName = Array.isArray(campRel)
      ? campRel[0]?.name ?? null
      : campRel?.name ?? null;
    const dayRel = p.camp_days as
      | { day_date: string }
      | { day_date: string }[]
      | null;
    const dayDate = Array.isArray(dayRel)
      ? dayRel[0]?.day_date ?? null
      : dayRel?.day_date ?? null;
    const volunteerRel = p.volunteer as
      | { full_name: string }
      | { full_name: string }[]
      | null;
    const checkedInByRel = p.checked_in_by_profile as
      | { full_name: string }
      | { full_name: string }[]
      | null;
    const doctorRel = p.doctor as
      | { full_name: string }
      | { full_name: string }[]
      | null;
    const volunteerName = Array.isArray(volunteerRel)
      ? volunteerRel[0]?.full_name ?? null
      : volunteerRel?.full_name ?? null;
    const checkedInByName = Array.isArray(checkedInByRel)
      ? checkedInByRel[0]?.full_name ?? null
      : checkedInByRel?.full_name ?? null;
    const doctorName = Array.isArray(doctorRel)
      ? doctorRel[0]?.full_name ?? null
      : doctorRel?.full_name ?? null;
    const createdBy = (p.created_by as string | null) ?? null;
    const checkedInBy = (p.checked_in_by as string | null) ?? null;
    const seenBy = (p.seen_by as string | null) ?? null;
    return {
      id: p.id as string,
      user_id: (p.user_id as string | null) ?? null,
      reg_no: p.reg_no as number,
      full_name: p.full_name as string,
      phone: (p.phone as string | null) ?? null,
      queue_status: p.queue_status as string,
      gender: (p.gender as string | null) ?? null,
      age: (p.age as number | null) ?? null,
      created_at: p.created_at as string,
      camp_id: p.camp_id as string,
      camps: campName ? { name: campName } : null,
      day_date: dayDate,
      created_by: createdBy,
      checked_in_by: checkedInBy,
      seen_by: seenBy,
      queued_at: (p.queued_at as string | null) ?? null,
      seen_at: (p.seen_at as string | null) ?? null,
      volunteer_name: volunteerName,
      checked_in_by_name: checkedInByName,
      doctor_name: doctorName,
      passcode_issued_at:
        (p.passcode_issued_at as string | null | undefined) ?? null,
    };
  });

  const queueCounts = Array.isArray(queueCountsRes.data)
    ? queueCountsRes.data[0]
    : queueCountsRes.data;
  const registered = Number(queueCounts?.registered_count ?? 0);
  const waiting = Number(queueCounts?.waiting_count ?? 0);
  const doctorSeen = Number(queueCounts?.seen_count ?? 0);
  const avgWaitMin =
    queueCounts?.avg_wait_minutes != null
      ? Number(queueCounts.avg_wait_minutes)
      : null;

  return (
    <div className="space-y-3 sm:space-y-4">
      {camp ? (
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Stat label="Active registered" value={registered} />
          <Stat label="Active queue" value={waiting} tone="wait" />
          <Stat label="Active seen" value={doctorSeen} tone="ok" />
        </div>
      ) : (
        <EmptyState>
          No active camp. Historical patients remain available below.
        </EmptyState>
      )}

      <Card className="bg-gradient-to-br from-brand-soft/70 to-card !p-4 sm:!p-5">
        <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand sm:text-xs">
          Patient desk
        </p>
        <p className="text-sm text-muted">
          Who registered them, who saw them, and when. Average wait is from
          queue join to doctor seen.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 lg:hidden">
          <NavLink href="/register" variant="primary">
            Register
          </NavLink>
          <NavLink href="/admin" variant="soft">
            Admin
          </NavLink>
        </div>
        <div className="desk-inline-actions mt-4">
          <NavLink href="/admin" variant="soft">
            Back to admin
          </NavLink>
          <NavLink href="/register" variant="primary">
            Register patient
          </NavLink>
        </div>
      </Card>

      <Card>
        <AdminPatients
          initial={patients}
          totalCount={patientsRes.count ?? patients.length}
          avgWaitMinutes={avgWaitMin}
          showAttribution
        />
      </Card>
    </div>
  );
}

export default async function PatientDeskPage() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") redirect("/login");

  return (
    <Shell
      title="Patient desk"
      subtitle="All patients · volunteer · doctor · timestamps"
      width="xl"
      roleLabel="Admin"
      actions={<SignOutButton place="header" />}
      dock={[
        { href: "/register", label: "Register", primary: true },
        { href: "/admin", label: "Admin" },
        { href: "/volunteer", label: "Volunteers" },
      ]}
    >
      <Suspense
        fallback={
          <Card className="p-6 text-sm text-muted">
            <p role="status">Loading patient desk data…</p>
          </Card>
        }
      >
        <PatientDeskContent />
      </Suspense>
    </Shell>
  );
}
