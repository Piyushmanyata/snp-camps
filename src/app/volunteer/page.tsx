import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { Badge, Card, Shell } from "@/components/ui";
import { QrScanner } from "@/components/qr-scanner";
import { SignOutButton } from "@/components/sign-out";

export default async function VolunteerPage() {
  const { profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) redirect("/login");

  const supabase = await createClient();
  const { data: camp } = await supabase
    .from("camps")
    .select("id, name")
    .eq("is_active", true)
    .maybeSingle();

  const { data: queue } = camp
    ? await supabase
        .from("patients")
        .select("id, reg_no, full_name, queue_status, created_at")
        .eq("camp_id", camp.id)
        .order("created_at", { ascending: true })
        .limit(100)
    : { data: [] };

  const waiting = (queue || []).filter((p) => p.queue_status === "waiting");
  const seen = (queue || []).filter((p) => p.queue_status === "seen");

  return (
    <Shell title="Volunteer desk" backHref="/">
      <div className="space-y-4">
        <Card>
          <p className="text-sm text-muted">Active camp</p>
          <p className="text-lg font-semibold">{camp?.name || "None"}</p>
          <div className="mt-3 flex gap-2 text-sm">
            <Badge tone="wait">{waiting.length} waiting</Badge>
            <Badge tone="ok">{seen.length} seen</Badge>
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 font-semibold">Scan patient QR</h2>
          <QrScanner />
        </Card>

        <Link
          href="/register"
          className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-brand font-semibold text-white"
        >
          Register walk-in patient
        </Link>

        <Card>
          <h2 className="mb-3 font-semibold">Queue (FCFS)</h2>
          <ul className="divide-y divide-border">
            {(queue || []).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-3">
                <div>
                  <p className="font-medium">
                    #{p.reg_no} {p.full_name}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={p.queue_status === "seen" ? "ok" : "wait"}>
                    {p.queue_status}
                  </Badge>
                  <Link
                    href={`/print/${p.id}`}
                    className="rounded-lg border border-border px-2 py-1 text-sm font-medium"
                  >
                    Print
                  </Link>
                </div>
              </li>
            ))}
            {!queue?.length ? (
              <li className="py-3 text-sm text-muted">No patients yet.</li>
            ) : null}
          </ul>
        </Card>

        {profile?.role === "admin" ? (
          <Link href="/admin" className="block text-center text-brand underline">
            Admin dashboard
          </Link>
        ) : null}
        <SignOutButton />
      </div>
    </Shell>
  );
}
