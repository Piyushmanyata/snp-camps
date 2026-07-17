import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { queueLabel, queueTone } from "@/lib/types";
import {
  Badge,
  Card,
  EmptyState,
  NavLink,
  SectionTitle,
  Shell,
  Stat,
} from "@/components/ui";
import { QrScanner } from "@/components/qr-scanner";
import { SignOutButton } from "@/components/sign-out";

export default async function VolunteerPage() {
  const { profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) redirect("/login");

  const supabase = await createClient();
  const { data: camp } = await supabase
    .from("camps")
    .select("id, name, venue")
    .eq("is_active", true)
    .maybeSingle();

  // Only people who checked in (waiting) or were served (seen) — not mere registrations
  const { data: queue } = camp
    ? await supabase
        .from("patients")
        .select("id, reg_no, full_name, queue_status, created_at, queued_at, phone")
        .eq("camp_id", camp.id)
        .in("queue_status", ["waiting", "seen"])
        .order("queued_at", { ascending: true, nullsFirst: false })
        .limit(150)
    : { data: [] };

  const waiting = (queue || []).filter((p) => p.queue_status === "waiting");
  const seen = (queue || []).filter((p) => p.queue_status === "seen");

  // FCFS: waiting first (by queued_at), then seen
  const ordered = [...waiting, ...seen];

  return (
    <Shell
      title="Volunteer desk"
      subtitle={profile?.full_name || "Check-in · queue · print"}
      backHref={profile?.role === "admin" ? "/admin" : "/"}
      width="xl"
    >
      <div className="space-y-4">
        <Card className="bg-gradient-to-br from-brand-soft/70 to-card">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-brand">
                Active camp
              </p>
              <p className="text-xl font-bold tracking-tight">
                {camp?.name || "None"}
              </p>
              {camp?.venue ? (
                <p className="text-sm text-muted">{camp.venue}</p>
              ) : null}
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:max-w-xs">
              <Stat label="In queue" value={waiting.length} tone="wait" />
              <Stat label="Seen" value={seen.length} tone="ok" />
            </div>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <div className="space-y-4">
            <Card>
              <SectionTitle hint="Adds to queue">Check in patient</SectionTitle>
              <QrScanner />
            </Card>
            <NavLink href="/register" variant="primary">
              Register walk-in patient
            </NavLink>
          </div>

          <Card padding="sm">
            <div className="px-1 pt-1">
              <SectionTitle hint="FCFS after check-in">Live queue</SectionTitle>
            </div>
            <ul className="divide-y divide-border lg:max-h-[70vh] lg:overflow-y-auto">
              {ordered.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2 px-1 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold">
                      <span className="tabular-nums text-brand">#{p.reg_no}</span>{" "}
                      {p.full_name}
                    </p>
                    {p.phone ? (
                      <p className="truncate text-xs text-muted">{p.phone}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={queueTone(p.queue_status)}>
                      {queueLabel(p.queue_status)}
                    </Badge>
                    <Link
                      href={`/print/${p.id}`}
                      className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-sm font-semibold text-brand shadow-sm transition hover:bg-brand-soft"
                    >
                      Print
                    </Link>
                  </div>
                </li>
              ))}
              {!ordered.length ? (
                <li className="px-1 py-2">
                  <EmptyState>
                    Queue is empty. Scan a patient QR or enter reg no to check
                    them in.
                  </EmptyState>
                </li>
              ) : null}
            </ul>
          </Card>
        </div>

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
