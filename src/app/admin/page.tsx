import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Card, NavLink, Shell, Stat } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import { AdminCamps } from "@/components/admin-camps";
import { AdminSearch } from "@/components/admin-search";
import { AdminVolunteers } from "@/components/admin-volunteers";

export default async function AdminPage() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") redirect("/login");

  const supabase = await createClient();
  const { data: camps } = await supabase
    .from("camps")
    .select("*")
    .order("created_at", { ascending: false });

  const active = camps?.find((c) => c.is_active);

  let waiting = 0;
  let seen = 0;
  let total = 0;
  if (active) {
    const { data: patients } = await supabase
      .from("patients")
      .select("queue_status")
      .eq("camp_id", active.id);
    total = patients?.length || 0;
    waiting = patients?.filter((p) => p.queue_status === "waiting").length || 0;
    seen = patients?.filter((p) => p.queue_status === "seen").length || 0;
  }

  const { data: volunteers } = await supabase
    .from("profiles")
    .select("id, full_name, email, phone, role, created_at")
    .eq("role", "volunteer")
    .order("created_at", { ascending: false });

  return (
    <Shell
      title="Admin"
      subtitle={profile?.full_name || "Camp control"}
      backHref="/"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2.5">
          <Stat label="Registered" value={total} />
          <Stat label="Waiting" value={waiting} tone="wait" />
          <Stat label="Seen" value={seen} tone="ok" />
        </div>

        <Card className="bg-gradient-to-br from-brand-soft/80 to-card">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand">
            Active camp
          </p>
          <p className="mt-0.5 text-xl font-bold tracking-tight">
            {active?.name || "None set"}
          </p>
          {active?.venue ? (
            <p className="text-sm text-muted">{active.venue}</p>
          ) : null}
          <p className="mt-2 text-xs text-muted">
            {volunteers?.length ?? 0} volunteer
            {(volunteers?.length ?? 0) === 1 ? "" : "s"} on staff
          </p>
        </Card>

        <div className="grid gap-2.5">
          <NavLink href="/register" variant="primary">
            Register patient
          </NavLink>
          <NavLink href="/volunteer" variant="soft">
            Open volunteer desk
          </NavLink>
        </div>

        <AdminCamps camps={camps || []} />
        <AdminVolunteers initial={volunteers || []} />
        <AdminSearch />

        <SignOutButton />
      </div>
    </Shell>
  );
}
