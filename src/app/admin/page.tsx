import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Card, Shell } from "@/components/ui";
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
    <Shell title="Admin" backHref="/">
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Registered" value={total} />
          <Stat label="Waiting" value={waiting} />
          <Stat label="Seen" value={seen} />
        </div>

        <Card>
          <p className="text-sm text-muted">Active camp</p>
          <p className="text-lg font-semibold">{active?.name || "None set"}</p>
          <p className="text-sm text-muted">
            Volunteers: {volunteers?.length ?? 0}
          </p>
        </Card>

        <AdminCamps camps={camps || []} />

        <AdminVolunteers initial={volunteers || []} />

        <AdminSearch />

        <Link
          href="/volunteer"
          className="inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-border bg-brand-soft font-semibold text-brand"
        >
          Open volunteer desk
        </Link>
        <Link
          href="/register"
          className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-brand font-semibold text-white"
        >
          Register patient
        </Link>
        <SignOutButton />
      </div>
    </Shell>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-3 text-center">
      <p className="text-2xl font-bold text-brand">{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}
