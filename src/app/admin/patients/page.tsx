import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Card, NavLink, Shell, Stat } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import {
  AdminPatients,
  type AdminPatientRow,
} from "@/components/admin-patients";

export default async function PatientDeskPage() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") redirect("/login");

  const supabase = await createClient();

  const { data: camp } = await supabase
    .from("camps")
    .select("id, name")
    .eq("is_active", true)
    .maybeSingle();

  const [patientsRes, queueCountsRes] = await Promise.all([
    supabase
      .from("patients")
      .select(
        "id, reg_no, full_name, phone, queue_status, gender, age, created_at, camp_id, camp_day_id, created_by, seen_by, queued_at, seen_at, camps(name), camp_days(day_date)",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .limit(50),
    camp
      ? supabase.rpc("camp_queue_counts", { p_camp_id: camp.id })
      : Promise.resolve({ data: [] }),
  ]);

  if (patientsRes.error) {
    throw new Error("Patient desk data could not be loaded");
  }

  const profileIds = new Set<string>();
  for (const p of patientsRes.data || []) {
    if (p.created_by) profileIds.add(p.created_by as string);
    if (p.seen_by) profileIds.add(p.seen_by as string);
  }

  const nameMap = new Map<string, string>();
  if (profileIds.size) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", [...profileIds]);
    for (const pr of profiles || []) {
      nameMap.set(pr.id as string, (pr.full_name as string) || "—");
    }
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
    const createdBy = (p.created_by as string | null) ?? null;
    const seenBy = (p.seen_by as string | null) ?? null;
    return {
      id: p.id as string,
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
      seen_by: seenBy,
      queued_at: (p.queued_at as string | null) ?? null,
      seen_at: (p.seen_at as string | null) ?? null,
      volunteer_name: createdBy ? nameMap.get(createdBy) ?? null : null,
      doctor_name: seenBy ? nameMap.get(seenBy) ?? null : null,
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
    <Shell
      title="Patient desk"
      subtitle={
        camp?.name
          ? `${camp.name} · all patients · wait times`
          : "All patients · volunteer · doctor · timestamps"
      }
      width="xl"
      roleLabel="Admin"
      actions={<SignOutButton place="header" />}
      dock={[
        { href: "/register", label: "Register", primary: true },
        { href: "/admin", label: "Admin" },
        { href: "/volunteer", label: "Volunteers" },
      ]}
    >
      <div className="space-y-3 sm:space-y-4">
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Stat label="Registered" value={registered} />
          <Stat label="In queue" value={waiting} tone="wait" />
          <Stat label="Doctor seen" value={doctorSeen} tone="ok" />
        </div>

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
    </Shell>
  );
}
