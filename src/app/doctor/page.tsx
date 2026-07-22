import { Suspense } from "react";
import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isDoctor, isAdmin, roleHome } from "@/lib/auth";
import {
  Card,
  CollapsibleSection,
  EmptyState,
  NavLink,
  SectionTitle,
  Shell,
  Stat,
} from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";

const QrScanner = dynamic(
  () =>
    import("@/components/qr-scanner").then((m) => ({ default: m.QrScanner })),
  {
    loading: () => (
      <p role="status" className="py-6 text-center text-sm text-muted">Loading scanner…</p>
    ),
  },
);

const AdminDoctors = dynamic(
  () =>
    import("@/components/admin-doctors").then((m) => ({
      default: m.AdminDoctors,
    })),
  {
    loading: () => (
      <p role="status" className="py-4 text-xs text-muted">Loading doctors…</p>
    ),
  },
);

async function DoctorStatsSection({
  campId,
}: {
  campId: string;
}) {
  const supabase = await createClient();
  const kolkataDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const startOfDay = new Date(kolkataDate + "T00:00:00+05:30");

  const { data: countsRes, error } = await supabase.rpc("doctor_my_counts", {
    p_camp_id: campId,
    p_since: startOfDay.toISOString(),
  });
  if (error) {
    return (
      <div className="grid w-full grid-cols-2 gap-2">
        <Stat label="You saw today" value={0} tone="ok" />
        <Stat label="Total seen" value={0} />
      </div>
    );
  }

  const counts = countsRes?.[0];
  const seenToday = Number(counts?.seen_today ?? 0);
  const myTotal = Number(counts?.seen_total ?? 0);

  return (
    <div className="grid w-full grid-cols-2 gap-2">
      <Stat label="You saw today" value={seenToday} tone="ok" />
      <Stat label="Total seen" value={myTotal} />
    </div>
  );
}

async function DoctorSeenSection({
  campId,
}: {
  campId: string;
}) {
  const supabase = await createClient();
  const { data: mySeenRes, error } = await supabase.rpc(
    "doctor_recent_patients",
    { p_camp_id: campId, p_limit: 50 },
  );

  const mySeen = (error || !mySeenRes ? [] : mySeenRes) as {
    id: string;
    reg_no: number;
    full_name: string;
    seen_at: string | null;
  }[];

  return (
    <div id="seen">
      <CollapsibleSection
        title="Patients you saw"
        hint={`${mySeen.length} recent`}
        defaultOpen
      >
        {mySeen.length ? (
          <ul className="divide-y divide-border">
            {mySeen.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    <span className="tabular text-brand">#{p.reg_no}</span>{" "}
                    {p.full_name}
                  </p>
                  <p className="text-xs text-muted">
                    {p.seen_at
                      ? new Date(p.seen_at).toLocaleString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          day: "numeric",
                          month: "short",
                        })
                      : "—"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>
            No patients assigned to you yet. Scan a registered patient or enter
            their reg number when they arrive.
          </EmptyState>
        )}
      </CollapsibleSection>
    </div>
  );
}

export default async function DoctorPage() {
  const { userId, profile } = await getSessionProfile();
  if (!userId) redirect("/login");
  if (!isDoctor(profile?.role) && !isAdmin(profile?.role)) {
    redirect(roleHome(profile?.role) || "/login");
  }

  const supabase = await createClient();
  const admin = isAdmin(profile?.role);

  if (admin) {
    let { data: doctorsFull, error } = await supabase
      .from("profiles")
      .select("id, full_name, email, phone, role, created_at, disabled_at")
      .eq("role", "doctor")
      .order("created_at", { ascending: false });

    if (error) {
      const fallback = await supabase
        .from("profiles")
        .select("id, full_name, email, phone, role, created_at")
        .eq("role", "doctor")
        .order("created_at", { ascending: false });
      doctorsFull = fallback.data as typeof doctorsFull;
      error = fallback.error;
    }
    if (error) throw new Error("Doctor desk data could not be loaded");
    const activeDoctors = doctorsFull?.filter((doctor) => !doctor.disabled_at).length ?? 0;
    const disabledDoctors = (doctorsFull?.length ?? 0) - activeDoctors;

    return (
      <Shell
        title="Doctor desk"
        subtitle="Manage doctors · KPIs · account access"
        width="xl"
        roleLabel="Admin"
        actions={<SignOutButton place="header" />}
        dock={[
          { href: "/admin", label: "Admin" },
          { href: "/register", label: "Register", primary: true },
          { href: "/admin/patients", label: "Patients" },
        ]}
      >
        <div className="space-y-4">
          <Card className="bg-gradient-to-br from-brand-soft to-card">
            <p className="text-xs font-bold uppercase tracking-wide text-brand">
              Staff management
            </p>
            <p className="text-xl font-bold tracking-tight">
              {activeDoctors} active doctor{activeDoctors === 1 ? "" : "s"}
            </p>
            <p className="mt-1 text-sm text-muted">
              {disabledDoctors
                ? `${disabledDoctors} disabled · `
                : ""}
              Tap a doctor for their KPIs and patients seen. Scanner and queue live
              on the main admin dashboard.
            </p>
            <div className="desk-inline-actions mt-4">
              <NavLink href="/admin" variant="soft">
                Back to admin
              </NavLink>
            </div>
          </Card>
          <Card>
            <AdminDoctors initial={doctorsFull || []} canManage />
          </Card>
        </div>
      </Shell>
    );
  }

  const { data: camp, error: campError } = await supabase
    .from("camps")
    .select("id, name, venue")
    .eq("is_active", true)
    .maybeSingle();

  if (campError) {
    throw new Error("Doctor desk data could not be loaded");
  }

  return (
    <Shell
      title="Doctor"
      subtitle={
        profile?.full_name
          ? `${profile.full_name} · Scan or enter reg number`
          : "Scan or enter reg number"
      }
      width="lg"
      roleLabel="Doctor"
      actions={<SignOutButton place="header" />}
      dock={[
        { href: "#scan", label: "Scan", primary: true },
        { href: "#seen", label: "Seen" },
      ]}
    >
      <div className="space-y-3 sm:space-y-4">
        <Card className="bg-gradient-to-br from-brand-soft to-card !p-4 sm:!p-5">
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand sm:text-xs">
                Active camp
              </p>
              <p className="text-lg font-bold tracking-tight sm:text-2xl">
                {camp?.name || "None"}
              </p>
              {camp?.venue ? (
                <p className="text-sm text-muted sm:text-[0.9375rem]">
                  {camp.venue}
                </p>
              ) : null}
            </div>
            {camp ? (
              <Suspense
                fallback={
                  <div className="grid w-full grid-cols-2 gap-2 opacity-60">
                    <Stat label="You saw today" value="…" tone="ok" />
                    <Stat label="Total seen" value="…" />
                  </div>
                }
              >
                <DoctorStatsSection campId={camp.id} />
              </Suspense>
            ) : (
              <div className="grid w-full grid-cols-2 gap-2">
                <Stat label="You saw today" value={0} tone="ok" />
                <Stat label="Total seen" value={0} />
              </div>
            )}
          </div>
          <div className="jump-chip-row mt-3 lg:hidden" aria-label="Jump">
            <a href="#scan" className="jump-chip">
              Scan
            </a>
            <a href="#seen" className="jump-chip">
              Patients seen
            </a>
          </div>
        </Card>

        <Card id="scan" className="!p-4 sm:!p-5">
          <SectionTitle hint="Scan QR or type reg number · review and confirm">
            Scan patient
          </SectionTitle>
          <QrScanner
            mode="doctor"
            doctors={[]}
            disabledReason={
              camp
                ? undefined
                : "No active camp. Ask an admin to activate a camp first."
            }
          />
        </Card>

        {camp ? (
          <Suspense
            fallback={
              <Card className="p-6 text-sm text-muted">
                <p role="status">Loading patients seen…</p>
              </Card>
            }
          >
            <DoctorSeenSection campId={camp.id} />
          </Suspense>
        ) : null}
      </div>
    </Shell>
  );
}
