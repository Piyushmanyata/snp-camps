import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isDoctor, isAdmin, roleHome } from "@/lib/auth";
import {
  Card,
  NavLink,
  SectionTitle,
  Shell,
  Stat,
} from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import { CampDeskLiveBridge } from "@/components/camp-desk-live-bridge";
import {
  DoctorSeenPanel,
  DoctorStatsPanel,
} from "@/components/section-data";
import {
  loadDoctorSeenSection,
  loadDoctorStatsSection,
} from "@/lib/section-reads";
import { mapDbError } from "@/lib/public-error";

const QrScanner = dynamic(
  () =>
    import("@/components/qr-scanner").then((m) => ({ default: m.QrScanner })),
  {
    loading: () => (
      <p role="status" className="py-6 text-center text-sm text-muted">Loading scanner…</p>
    ),
  },
);

const AdminStaff = dynamic(
  () =>
    import("@/components/admin-staff").then((m) => ({
      default: m.AdminStaff,
    })),
  {
    loading: () => (
      <p role="status" className="py-4 text-xs text-muted">Loading doctors…</p>
    ),
  },
);

export default async function DoctorPage() {
  const { userId, profile } = await getSessionProfile();
  if (!userId) redirect("/login");
  if (!isDoctor(profile?.role) && !isAdmin(profile?.role)) {
    redirect(roleHome(profile?.role) || "/login");
  }

  const supabase = await createClient();
  const admin = isAdmin(profile?.role);

  if (admin) {
    // No narrower-query fallback — column failures (incl. RLS) surface as errors.
    const { data: doctorsFull, error } = await supabase
      .from("profiles")
      .select("id, full_name, email, phone, role, created_at, disabled_at")
      .eq("role", "doctor")
      .order("created_at", { ascending: false });

    if (error) {
      mapDbError(error, { context: "doctor-page.admin-list" });
      throw new Error("Doctor desk data could not be loaded");
    }
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
          <Card className="bg-brand-soft">
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
            <AdminStaff role="doctor" initial={doctorsFull || []} canManage />
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
    mapDbError(campError, { context: "doctor-page.active-camp" });
    throw new Error("Doctor desk data could not be loaded");
  }

  // Independent section reads — stats failure must not blank scanner/seen (#63).
  const [statsInitial, seenInitial] = camp
    ? await Promise.all([
        loadDoctorStatsSection(camp.id),
        loadDoctorSeenSection(camp.id),
      ])
    : [null, null];

  return (
    <Shell
      title="Doctor"
      subtitle={
        profile?.full_name
          ? `${profile.full_name} · Scan or type, then Mark seen`
          : "Scan or type, then Mark seen"
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
        {camp ? <CampDeskLiveBridge campId={camp.id} /> : null}
        <Card className="bg-brand-soft !p-3 sm:!p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand sm:text-xs">
                Active camp
              </p>
              <p className="truncate text-base font-bold tracking-tight sm:text-lg">
                {camp?.name || "None"}
              </p>
            </div>
            {camp && statsInitial ? (
              <div className="sm:min-w-[14rem]">
                <DoctorStatsPanel campId={camp.id} initial={statsInitial} />
              </div>
            ) : (
              <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:min-w-[14rem]">
                <Stat label="You saw today" value={0} tone="ok" />
                <Stat label="Total seen" value={0} />
              </div>
            )}
          </div>
        </Card>

        <Card id="scan" className="!p-4 sm:!p-5">
          <SectionTitle hint="QR or reg number · one button">
            Patient
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

        {camp && seenInitial ? (
          <DoctorSeenPanel campId={camp.id} initial={seenInitial} />
        ) : null}
      </div>
    </Shell>
  );
}
