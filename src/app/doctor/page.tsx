import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isDoctor, isAdmin } from "@/lib/auth";
import {
  Card,
  CollapsibleSection,
  EmptyState,
  SectionTitle,
  Shell,
  Stat,
} from "@/components/ui";
import { QrScanner, type DoctorOption } from "@/components/qr-scanner";
import { SignOutButton } from "@/components/sign-out";
import { LiveQueue, type LiveQueuePatient } from "@/components/live-queue";
import { AdminDoctors } from "@/components/admin-doctors";

export default async function DoctorPage() {
  const { userId, profile } = await getSessionProfile();
  if (!userId) redirect("/login");
  if (!isDoctor(profile?.role) && !isAdmin(profile?.role)) {
    redirect("/login");
  }

  const supabase = await createClient();
  const { data: camp, error: campError } = await supabase
    .from("camps")
    .select("id, name, venue")
    .eq("is_active", true)
    .maybeSingle();

  const isDoc = profile?.role === "doctor";
  const doctorId = isDoc ? userId : null;
  const scanMode = isDoc ? "doctor" : "admin";
  const manage = isAdmin(profile?.role);

  const kolkataDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const startOfDay = new Date(kolkataDate + "T00:00:00+05:30");

  const [waitingRes, seenTodayRes, mySeenRes, doctorsRes, doctorsFullRes] =
    camp
      ? await Promise.all([
          supabase
            .from("patients")
            .select("id, reg_no, full_name, phone, queued_at", {
              count: "exact",
            })
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
          supabase
            .from("profiles")
            .select("id, full_name")
            .eq("role", "doctor")
            .order("full_name", { ascending: true }),
          supabase
            .from("profiles")
            .select("id, full_name, email, phone, role, created_at")
            .eq("role", "doctor")
            .order("created_at", { ascending: false }),
        ])
      : await Promise.all([
          Promise.resolve({ data: [] as LiveQueuePatient[], count: 0 }),
          Promise.resolve({ count: 0 }),
          Promise.resolve({
            data: [] as {
              id: string;
              reg_no: number;
              full_name: string;
              seen_at: string | null;
              phone: string | null;
            }[],
          }),
          Promise.resolve({ data: [] as DoctorOption[] }),
          supabase
            .from("profiles")
            .select("id, full_name, email, phone, role, created_at")
            .eq("role", "doctor")
            .order("created_at", { ascending: false }),
        ]);

  const waiting = (waitingRes.data || []) as LiveQueuePatient[];
  const waitingCount = waitingRes.count ?? waiting.length;
  const seenToday = seenTodayRes.count ?? 0;
  const mySeen = mySeenRes.data || [];
  const doctors = (doctorsRes.data || []) as DoctorOption[];
  const doctorsFull = doctorsFullRes.data || [];
  if (
    Boolean(campError) ||
    [waitingRes, seenTodayRes, mySeenRes, doctorsRes, doctorsFullRes].some(
      (result) => "error" in result && Boolean(result.error),
    )
  ) {
    throw new Error("Doctor desk data could not be loaded");
  }

  return (
    <Shell
      title="Doctor"
      subtitle={
        profile?.full_name
          ? `${profile.full_name} · Scan patients you see`
          : "Scan patients you see"
      }
      width="xl"
      roleLabel={isDoc ? "Doctor" : "Admin"}
      actions={<SignOutButton place="header" />}
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
              <Stat
                label={isDoc ? "You saw today" : "Doctors"}
                value={isDoc ? seenToday : doctors.length}
                tone="ok"
              />
            </div>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
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
            <QrScanner
              mode={scanMode}
              doctors={doctors}
              disabledReason={
                camp
                  ? undefined
                  : "No active camp. Ask an admin to activate a camp first."
              }
            />
          </Card>

          <Card padding="sm" id="queue">
            <div className="px-1 pt-1">
              <SectionTitle hint="Printed / waiting · optional queue">
                Live queue
              </SectionTitle>
            </div>
            <LiveQueue
              initial={waiting}
              initialTotal={waitingCount}
              campId={camp?.id ?? null}
              mode={isDoc ? "doctor" : "admin"}
              doctors={doctors}
            />
          </Card>
        </div>

        {isDoc ? (
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
                No patients assigned to you yet. Scan a registered patient when
                they arrive — no print required.
              </EmptyState>
            )}
          </CollapsibleSection>
        ) : null}

        <CollapsibleSection
          title="Doctors"
          hint={`${doctorsFull.length} · KPIs & register`}
          defaultOpen={!isDoc}
        >
          <AdminDoctors initial={doctorsFull} canManage={manage} />
        </CollapsibleSection>
      </div>
    </Shell>
  );
}
