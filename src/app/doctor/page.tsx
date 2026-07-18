import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isDoctor, isAdmin } from "@/lib/auth";
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
import { AdminDoctors } from "@/components/admin-doctors";

const QrScanner = dynamic(
  () =>
    import("@/components/qr-scanner").then((m) => ({ default: m.QrScanner })),
  {
    loading: () => (
      <p className="py-6 text-center text-sm text-muted">Loading scanner…</p>
    ),
  },
);

export default async function DoctorPage() {
  const { userId, profile } = await getSessionProfile();
  if (!userId) redirect("/login");
  if (!isDoctor(profile?.role) && !isAdmin(profile?.role)) {
    redirect("/login");
  }

  const supabase = await createClient();
  const admin = isAdmin(profile?.role);

  if (admin) {
    const { data: doctorsFull, error } = await supabase
      .from("profiles")
      .select("id, full_name, email, phone, role, created_at")
      .eq("role", "doctor")
      .order("created_at", { ascending: false });
    if (error) throw new Error("Doctor desk data could not be loaded");

    return (
      <Shell
        title="Doctor desk"
        subtitle="Manage doctors · KPIs · add / remove"
        width="xl"
        roleLabel="Admin"
        actions={<SignOutButton place="header" />}
      >
        <div className="space-y-4">
          <Card className="bg-gradient-to-br from-brand-soft/70 to-card">
            <p className="text-xs font-bold uppercase tracking-wide text-brand">
              Staff management
            </p>
            <p className="text-xl font-bold tracking-tight">
              {doctorsFull?.length ?? 0} doctor
              {(doctorsFull?.length ?? 0) === 1 ? "" : "s"}
            </p>
            <p className="mt-1 text-sm text-muted">
              Tap a doctor for their KPIs and patients seen. Scanner and queue
              live on the main admin dashboard.
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

  const kolkataDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const startOfDay = new Date(kolkataDate + "T00:00:00+05:30");

  let seenToday = 0;
  let myTotal = 0;
  let mySeen: {
    id: string;
    reg_no: number;
    full_name: string;
    seen_at: string | null;
    phone: string | null;
  }[] = [];

  if (camp) {
    const [countsRes, mySeenRes] = await Promise.all([
      supabase.rpc("doctor_my_counts", {
        p_camp_id: camp.id,
        p_since: startOfDay.toISOString(),
      }),
      supabase
        .from("patients")
        .select("id, reg_no, full_name, seen_at, phone")
        .eq("camp_id", camp.id)
        .eq("seen_by", userId)
        .eq("queue_status", "seen")
        .order("seen_at", { ascending: false })
        .limit(50),
    ]);

    if (countsRes.error || mySeenRes.error) {
      throw new Error("Doctor desk data could not be loaded");
    }

    const counts = countsRes.data?.[0];
    seenToday = Number(counts?.seen_today ?? 0);
    myTotal = Number(counts?.seen_total ?? 0);
    mySeen = mySeenRes.data || [];
  } else if (campError) {
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
        { href: "/register", label: "Register" },
      ]}
    >
      <div className="space-y-3 sm:space-y-4">
        <Card className="bg-gradient-to-br from-brand-soft/70 to-card !p-4 sm:!p-5">
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
            <div className="grid w-full grid-cols-2 gap-2">
              <Stat label="You saw today" value={seenToday} tone="ok" />
              <Stat label="Total doctor seen" value={myTotal} />
            </div>
          </div>
          <div className="jump-chip-row mt-3 lg:hidden" aria-label="Jump">
            <a href="#scan" className="jump-chip">
              Scan
            </a>
            <a href="#seen" className="jump-chip">
              Patients seen
            </a>
            <a href="/register" className="jump-chip">
              Register
            </a>
          </div>
        </Card>

        <Card id="scan" className="!p-4 sm:!p-5">
          <SectionTitle hint="Scan QR or type reg number · assigns to you">
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
                      {p.phone ? ` · ${p.phone}` : ""}
                    </p>
                  </div>
                  <a
                    href={`/print/${p.id}`}
                    className="pressable shrink-0 rounded-lg border border-border bg-brand-soft px-3 py-2 text-xs font-semibold text-brand hover:bg-white"
                  >
                    Form
                  </a>
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
      </div>
    </Shell>
  );
}
