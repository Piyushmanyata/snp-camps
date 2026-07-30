import { redirect } from "next/navigation";
import { getSessionProfile, roleHome } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Shell, NavLink } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import {
  AdminClinicalRecords,
  type ClinicalRecord,
} from "@/components/admin-clinical-records";

export default async function AdminClinicalPage() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") redirect(roleHome(profile?.role) || "/login");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_clinical_records", {
    p_include_archived: false,
  });
  return (
    <Shell
      title="Clinical records"
      subtitle="Authorized review, export, archive, and corrections"
      roleLabel="Admin"
      actions={<SignOutButton place="header" />}
    >
      <div className="mb-4"><NavLink href="/admin" variant="soft">Back to Admin</NavLink></div>
      <AdminClinicalRecords
        initial={(data ?? []) as ClinicalRecord[]}
        initialError={error ? "Clinical records could not be loaded." : null}
      />
    </Shell>
  );
}
