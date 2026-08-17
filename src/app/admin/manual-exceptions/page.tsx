import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/sign-out";
import { Card, EmptyState, ErrorBox, NavLink, Shell } from "@/components/ui";
import { getSessionProfile, roleHome } from "@/lib/auth";
import { mapDbError } from "@/lib/public-error";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Manual exceptions" };

type ActorName = { full_name: string } | { full_name: string }[] | null;

function actorName(rel: ActorName) {
  if (Array.isArray(rel)) return rel[0]?.full_name ?? "Unknown";
  return rel?.full_name ?? "Unknown";
}

export default async function ManualExceptionsPage() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    redirect(roleHome(profile?.role) || "/login");
  }

  const supabase = await createClient();
  const { data: camp, error: campError } = await supabase
    .from("camps")
    .select("id, name")
    .eq("is_active", true)
    .maybeSingle();

  let loadError: string | null = null;
  if (campError) {
    loadError = mapDbError(campError, {
      context: "manual-exceptions.active-camp",
      fallback: "Active camp could not be loaded.",
    });
  }

  const { data: rows, error: listError } = camp
    ? await supabase
        .from("patients")
        .select(
          "reg_no, full_name, manual_exception_reason, failed_scan_attempts, manual_exception_at, actor:profiles!manual_exception_actor(full_name)",
        )
        .eq("camp_id", camp.id)
        .not("manual_exception_at", "is", null)
        .order("manual_exception_at", { ascending: false })
    : { data: [], error: null };

  if (listError) {
    loadError = mapDbError(listError, {
      context: "manual-exceptions.list",
      fallback: "Manual exceptions could not be loaded.",
    });
  }

  const exceptions = rows ?? [];

  return (
    <Shell
      title="Manual exceptions"
      subtitle={camp?.name ? `Active camp · ${camp.name}` : "Active camp"}
      width="xl"
      roleLabel="Admin"
      actions={<SignOutButton place="header" />}
      dock={[
        { href: "/admin", label: "Admin", primary: true },
        { href: "/admin/patients", label: "Patients" },
        { href: "/register", label: "Register" },
      ]}
    >
      <div className="space-y-4">
        {loadError ? <ErrorBox message={loadError} /> : null}
        <Card className="bg-brand-soft">
          <p className="text-xs font-bold uppercase tracking-wide text-brand">
            Per-camp audit
          </p>
          <p className="text-xl font-bold tracking-tight">
            {exceptions.length} manual exception
            {exceptions.length === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-sm text-muted">
            Read-only. Actor, reason, and attempt count come from the
            registration row.
          </p>
          <div className="desk-inline-actions mt-4">
            <NavLink href="/admin" variant="soft">
              Back to Admin
            </NavLink>
          </div>
        </Card>
        {exceptions.length === 0 ? (
          <EmptyState title="No manual exceptions">
            When Registration Staff complete a manual entry, it will appear
            here.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {exceptions.map((row) => (
              <li key={row.reg_no}>
                <Card>
                  <p className="text-lg font-bold tracking-tight">
                    #{row.reg_no} · {row.full_name}
                  </p>
                  <dl className="mt-2 grid gap-1 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Authorised by</dt>
                      <dd className="font-semibold text-right">
                        {actorName(row.actor as ActorName)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Attempts</dt>
                      <dd className="font-semibold">
                        {row.failed_scan_attempts}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">When</dt>
                      <dd className="font-semibold text-right">
                        {row.manual_exception_at
                          ? new Date(row.manual_exception_at).toLocaleString(
                              "en-IN",
                            )
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Reason</dt>
                      <dd className="mt-0.5 font-medium">
                        {row.manual_exception_reason}
                      </dd>
                    </div>
                  </dl>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Shell>
  );
}
