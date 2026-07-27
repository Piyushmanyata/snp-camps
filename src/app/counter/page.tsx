import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isCampCrew, roleHome } from "@/lib/auth";
import { Shell } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import { CounterDeskPanel } from "@/components/counter-desk-panel";
import { mapDbError } from "@/lib/public-error";

export default async function CounterPage() {
  const { userId, profile } = await getSessionProfile();
  if (!userId) redirect("/login");
  if (!isCampCrew(profile?.role)) {
    redirect(roleHome(profile?.role) || "/login");
  }

  const supabase = await createClient();

  const { data: camp, error: campError } = await supabase
    .from("camps")
    .select("id, name, venue")
    .eq("is_active", true)
    .maybeSingle();

  if (campError) {
    mapDbError(campError, { context: "counter-page.active-camp" });
    throw new Error("Counter desk data could not be loaded");
  }

  return (
    <Shell
      title="Counter desk"
      subtitle={
        camp
          ? `${camp.name} · Fulfil, defer, and cancel orders`
          : "Fulfil, defer, and cancel orders"
      }
      width="xl"
      roleLabel="Staff"
      actions={<SignOutButton place="header" />}
      dock={[
        { href: "/counter", label: "Counter", primary: true },
        { href: "/register", label: "Register" },
        { href: "/admin/patients", label: "Patients" },
      ]}
    >
      <CounterDeskPanel campId={camp?.id ?? null} />
    </Shell>
  );
}
