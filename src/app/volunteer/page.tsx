import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff, isDoctor } from "@/lib/auth";
import {
  Card,
  NavLink,
  SectionTitle,
  Shell,
  Stat,
} from "@/components/ui";
import { QrScanner, type DoctorOption } from "@/components/qr-scanner";
import { SignOutButton } from "@/components/sign-out";
import { LiveQueue, type LiveQueuePatient } from "@/components/live-queue";

export default async function VolunteerPage() {
  const { profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) redirect("/login");
  if (isDoctor(profile?.role)) redirect("/doctor");

  const supabase = await createClient();
  const { data: camp, error: campError } = await supabase
    .from("camps")
    .select("id, name, venue")
    .eq("is_active", true)
    .maybeSingle();

  const [waitingRes, seenCountRes, doctorsRes] = camp
    ? await Promise.all([
        supabase
          .from("patients")
          .select("id, reg_no, full_name, phone, queued_at", { count: "exact" })
          .eq("camp_id", camp.id)
          .eq("queue_status", "waiting")
          .order("queued_at", { ascending: true, nullsFirst: false })
          .limit(100),
        supabase
          .from("patients")
          .select("id", { count: "exact", head: true })
          .eq("camp_id", camp.id)
          .eq("queue_status", "seen"),
        supabase
          .from("profiles")
          .select("id, full_name")
          .eq("role", "doctor")
          .order("full_name", { ascending: true }),
      ])
    : [
        { data: [] as LiveQueuePatient[], count: 0 },
        { count: 0 },
        { data: [] as DoctorOption[] },
      ];

  const waiting = (waitingRes.data || []) as LiveQueuePatient[];
  const waitingCount = waitingRes.count ?? waiting.length;
  const seenCount = seenCountRes.count ?? 0;
  const doctors = (doctorsRes.data || []) as DoctorOption[];
  if (
    Boolean(campError) ||
    [waitingRes, seenCountRes, doctorsRes].some(
      (result) => "error" in result && Boolean(result.error),
    )
  ) {
    throw new Error("Volunteer desk data could not be loaded");
  }

  const dock = [
    { href: "/register", label: "Register", primary: true },
    { href: "#scan", label: "Scan" },
    { href: "#queue", label: "Queue" },
  ];

  return (
    <Shell
      title="Volunteer desk"
      subtitle={
        profile?.full_name
          ? `${profile.full_name} · Print → queue · Scan → assign doctor`
          : "Print → queue · Scan → assign doctor"
      }
      backHref={profile?.role === "admin" ? "/admin" : "/"}
      width="xl"
      roleLabel="Volunteer"
      dock={dock}
    >
      <div className="space-y-4">
        <Card className="bg-gradient-to-br from-brand-soft/70 to-card">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-brand">
                Active camp
              </p>
              <p className="text-xl font-bold tracking-tight sm:text-2xl">
                {camp?.name || "None"}
              </p>
              {camp?.venue ? (
                <p className="text-[0.9375rem] text-muted">{camp.venue}</p>
              ) : null}
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:max-w-xs">
              <Stat label="In queue" value={waitingCount} tone="wait" />
              <Stat label="Seen" value={seenCount} tone="ok" />
            </div>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <div className="space-y-4">
            <Card id="scan">
              <SectionTitle hint="After print · pick doctor">
                Scan / assign doctor
              </SectionTitle>
              <QrScanner
                mode="volunteer"
                doctors={doctors}
                disabledReason={
                  camp ? undefined : "No active camp. Ask an admin to activate a camp first."
                }
              />
            </Card>
            <div className="desk-inline-actions">
              <NavLink href="/register" variant="primary">
                Register walk-in patient
              </NavLink>
            </div>
          </div>

          <Card padding="sm" id="queue">
            <div className="px-1 pt-1">
              <SectionTitle hint="First come, first served">
                Live queue
              </SectionTitle>
            </div>
            <LiveQueue
              initial={waiting}
              initialTotal={waitingCount}
              campId={camp?.id ?? null}
              doctors={doctors}
              mode="volunteer"
            />
          </Card>
        </div>

        {profile?.role === "admin" ? (
          <div className="desk-inline-actions">
            <NavLink href="/admin" variant="secondary">
              Admin dashboard
            </NavLink>
          </div>
        ) : null}
        <SignOutButton />
      </div>
    </Shell>
  );
}
