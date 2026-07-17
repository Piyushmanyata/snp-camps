import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isDoctor, isAdmin } from "@/lib/auth";
import {
  Card,
  EmptyState,
  NavLink,
  SectionTitle,
  Shell,
  Stat,
} from "@/components/ui";
import { QrScanner, type DoctorOption } from "@/components/qr-scanner";
import { SignOutButton } from "@/components/sign-out";
import { LiveQueue, type LiveQueuePatient } from "@/components/live-queue";

export default async function DoctorPage() {
  const { userId, profile } = await getSessionProfile();
  if (!userId) redirect("/login");
  if (!isDoctor(profile?.role) && !isAdmin(profile?.role)) {
    redirect("/login");
  }

  const supabase = await createClient();
  const { data: camp } = await supabase
    .from("camps")
    .select("id, name, venue")
    .eq("is_active", true)
    .maybeSingle();

  const isDoc = profile?.role === "doctor";
  const doctorId = isDoc ? userId : null;
  const scanMode = isDoc ? "doctor" : "admin";

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [waitingRes, seenTodayRes, mySeenRes, doctorsRes] = camp
    ? await Promise.all([
        supabase
          .from("patients")
          .select("id, reg_no, full_name, phone, queued_at")
          .eq("camp_id", camp.id)
          .eq("queue_status", "waiting")
          .order("queued_at", { ascending: true, nullsFirst: false })
          .limit(100),
        doctorId
          ? supabase
              .from("patients")
              .select("id", { count: "exact", head: true })
              .eq("camp_id", camp.id)
              .eq("queue_status", "seen")
              .eq("seen_by", doctorId)
              .gte("seen_at", startOfDay.toISOString())
          : Promise.resolve({ count: 0 }),
        doctorId
          ? supabase
              .from("patients")
              .select("id, reg_no, full_name, seen_at, phone")
              .eq("camp_id", camp.id)
              .eq("seen_by", doctorId)
              .eq("queue_status", "seen")
              .order("seen_at", { ascending: false })
              .limit(50)
          : Promise.resolve({
              data: [] as {
                id: string;
                reg_no: number;
                full_name: string;
                seen_at: string | null;
                phone: string | null;
              }[],
            }),
        !isDoc
          ? supabase
              .from("profiles")
              .select("id, full_name")
              .eq("role", "doctor")
              .order("full_name", { ascending: true })
          : Promise.resolve({ data: [] as DoctorOption[] }),
      ])
    : [
        { data: [] as LiveQueuePatient[] },
        { count: 0 },
        {
          data: [] as {
            id: string;
            reg_no: number;
            full_name: string;
            seen_at: string | null;
            phone: string | null;
          }[],
        },
        { data: [] as DoctorOption[] },
      ];

  const waiting = (waitingRes.data || []) as LiveQueuePatient[];
  const seenToday = seenTodayRes.count ?? 0;
  const mySeen = mySeenRes.data || [];
  const doctors = (doctorsRes.data || []) as DoctorOption[];

  return (
    <Shell
      title="Doctor"
      subtitle={
        profile?.full_name
          ? `${profile.full_name} · Scan patients you see`
          : "Scan patients you see"
      }
      backHref={profile?.role === "admin" ? "/admin" : "/"}
      width="xl"
      roleLabel={isDoc ? "Doctor" : "Admin"}
      dock={[
        { href: "#scan", label: "Scan", primary: true },
        { href: "#queue", label: "Queue" },
        { href: "#seen", label: "Seen" },
      ]}
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
              <Stat label="In queue" value={waiting.length} tone="wait" />
              <Stat label="You saw today" value={seenToday} tone="ok" />
            </div>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <div className="space-y-4">
            <Card id="scan">
              <SectionTitle
                hint={
                  isDoc
                    ? "No print needed · once only"
                    : "Pick doctor · once only"
                }
              >
                Scan patient
              </SectionTitle>
              <QrScanner mode={scanMode} doctors={doctors} />
            </Card>
          </div>

          <Card padding="sm" id="queue">
            <div className="px-1 pt-1">
              <SectionTitle hint="Printed / waiting · optional queue">
                Live queue
              </SectionTitle>
            </div>
            <LiveQueue
              initial={waiting}
              mode={isDoc ? "doctor" : "admin"}
              doctors={doctors}
            />
          </Card>
        </div>

        <Card id="seen">
          <SectionTitle hint={`${mySeen.length} recent`}>
            Patients you saw
          </SectionTitle>
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
              No patients assigned to you yet. Scan a registered patient when
              they arrive — no print required.
            </EmptyState>
          )}
        </Card>

        {profile?.role === "admin" ? (
          <NavLink href="/admin" variant="secondary">
            Admin dashboard
          </NavLink>
        ) : null}
        <SignOutButton />
      </div>
    </Shell>
  );
}
