import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { Card, Shell } from "@/components/ui";
import { PatientForm } from "@/components/patient-form";

export default async function RegisterPage() {
  const supabase = await createClient();
  const { userId, profile } = await getSessionProfile();

  const { data: camp } = await supabase
    .from("camps")
    .select("id, name, venue, camp_date")
    .eq("is_active", true)
    .maybeSingle();

  return (
    <Shell title="Register patient" backHref="/">
      {!camp ? (
        <Card>
          <p className="text-muted">
            No active camp. Ask admin to create/activate a camp first.
          </p>
          {profile?.role === "admin" ? (
            <Link href="/admin" className="mt-3 inline-block text-brand underline">
              Go to admin
            </Link>
          ) : null}
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <p className="text-sm text-muted">Active camp</p>
            <p className="text-lg font-semibold">{camp.name}</p>
            {camp.venue ? <p className="text-sm text-muted">{camp.venue}</p> : null}
          </Card>
          <Card>
            <PatientForm
              campId={camp.id}
              userId={profile?.role === "patient" ? userId : null}
              createdBy={isStaff(profile?.role) ? userId : null}
              defaultPhone={profile?.phone || ""}
            />
          </Card>
        </div>
      )}
    </Shell>
  );
}
