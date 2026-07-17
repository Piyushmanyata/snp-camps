import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
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

  const { data: queue } = camp
    ? await supabase
        .from("patients")
        .select("id, reg_no, full_name, queue_status, created_at, phone")
        .eq("camp_id", camp.id)
        .order("created_at", { ascending: true })
        .limit(100)
    : { data: [] };

  const waiting = (queue || []).filter((p) => p.queue_status === "waiting");
  const seen = (queue || []).filter((p) => p.queue_status === "seen");

  return (
    <Shell
      title="Volunteer desk"
      subtitle={profile?.full_name || "Scan · print · queue"}
      backHref={profile?.role === "admin" ? "/admin" : "/"}
    >
      <div className="space-y-4">
        <Card className="bg-gradient-to-br from-brand-soft/70 to-card">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand">
            Active camp
          </p>
          <p className="text-xl font-bold tracking-tight">
            {camp?.name || "None"}
          </p>
          {camp?.venue ? (
            <p className="text-sm text-muted">{camp.venue}</p>
          ) : null}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Stat label="Waiting" value={waiting.length} tone="wait" />
            <Stat label="Seen" value={seen.length} tone="ok" />
          </div>
        </Card>

        <Card>
          <SectionTitle hint="Camera or reg no">Scan patient QR</SectionTitle>
          <QrScanner />
        </Card>

        <NavLink href="/register" variant="primary">
          Register walk-in patient
        </NavLink>

        <Card padding="sm">
          <div className="px-1 pt-1">
            <SectionTitle hint="FCFS order">Queue</SectionTitle>
          </div>
          <ul className="divide-y divide-border">
            {(queue || []).map((p) => (
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
                  <Badge tone={p.queue_status === "seen" ? "ok" : "wait"}>
                    {p.queue_status}
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
            {!queue?.length ? (
              <li className="px-1 py-2">
                <EmptyState>No patients yet — register a walk-in.</EmptyState>
              </li>
            ) : null}
          </ul>
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
