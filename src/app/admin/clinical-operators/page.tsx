import { redirect } from "next/navigation";
import { AdminStaff } from "@/components/admin-staff";
import { SignOutButton } from "@/components/sign-out";
import { Card, ErrorBox, NavLink, Shell } from "@/components/ui";
import { getSessionProfile, roleHome } from "@/lib/auth";
import { mapDbError } from "@/lib/public-error";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Clinical Desk Accounts" };

export default async function ClinicalOperatorsPage() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    redirect(roleHome(profile?.role) || "/login");
  }

  const supabase = await createClient();
  const { data: operators, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, phone, role, created_at, disabled_at")
    .eq("role", "clinical_operator")
    .order("created_at", { ascending: false });

  let loadError: string | null = null;
  if (error) {
    loadError = mapDbError(error, {
      context: "clinical-operators-page.list",
      fallback: "Clinical Desk accounts could not be loaded.",
    });
  }

  const active = operators?.filter((operator) => !operator.disabled_at).length ?? 0;
  const disabled = (operators?.length ?? 0) - active;

  return (
    <Shell
      title="Clinical Desk Accounts"
      subtitle="Manage the separate post-doctor station role"
      width="xl"
      roleLabel="Admin"
      actions={<SignOutButton place="header" />}
      dock={[
        { href: "/admin", label: "Admin", primary: true },
        { href: "/clinical", label: "Open Clinical Desk" },
        { href: "/admin/clinical", label: "Clinical records" },
      ]}
    >
      <div className="space-y-4">
        {loadError ? <ErrorBox message={loadError} /> : null}
        <Card className="bg-brand-soft">
          <p className="text-xs font-bold uppercase tracking-wide text-brand">
            Separate station role
          </p>
          <p className="text-xl font-bold tracking-tight">
            {active} active Clinical Desk Operator{active === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-sm text-muted">
            {disabled ? `${disabled} disabled · ` : ""}
            Operators cannot register patients, manage teams, or access
            registration leaderboards.
          </p>
          <div className="desk-inline-actions mt-4">
            <NavLink href="/clinical" variant="soft">
              Open Clinical Desk
            </NavLink>
            <NavLink href="/admin/clinical" variant="soft">
              Review clinical records
            </NavLink>
          </div>
        </Card>
        <Card>
          <AdminStaff
            role="clinical_operator"
            initial={operators || []}
            canManage
            canViewDetail={false}
          />
        </Card>
      </div>
    </Shell>
  );
}
