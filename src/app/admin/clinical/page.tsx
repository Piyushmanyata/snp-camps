import { redirect } from "next/navigation";
import { getSessionProfile, roleHome } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Shell, NavLink } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import {
  AdminClinicalRecords,
  type ClinicalCampOption,
  type ClinicalRecord,
} from "@/components/admin-clinical-records";

export default async function AdminClinicalPage() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") redirect(roleHome(profile?.role) || "/login");
  const supabase = await createClient();
  const { data: campRows } = await supabase
    .from("camps")
    .select("id,name,is_active")
    .order("is_active", { ascending: false })
    .order("name");
  const camps = (campRows ?? []) as ClinicalCampOption[];
  const activeCampId = camps.find((camp) => camp.is_active)?.id ?? null;
  let page: { records: ClinicalRecord[]; total: number } = {
    records: [],
    total: 0,
  };
  let loadError: string | null = null;
  if (activeCampId) {
    const { data, error } = await supabase.rpc("admin_clinical_records", {
      p_camp_id: activeCampId,
      p_include_archived: false,
      p_limit: 50,
      p_offset: 0,
    });
    page = (data ?? { records: [], total: 0 }) as {
      records: ClinicalRecord[];
      total: number;
    };
    loadError = error ? "Clinical records could not be loaded." : null;
  }
  return (
    <Shell
      title="Clinical records"
      subtitle="Authorized review, export, archive, and corrections"
      roleLabel="Admin"
      actions={<SignOutButton place="header" />}
    >
      <div className="mb-4"><NavLink href="/admin" variant="soft">Back to Admin</NavLink></div>
      <AdminClinicalRecords
        initial={page.records}
        initialTotal={page.total}
        initialError={loadError}
        camps={camps}
        activeCampId={activeCampId}
      />
    </Shell>
  );
}
