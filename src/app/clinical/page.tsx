import { redirect } from "next/navigation";
import { getSessionProfile, roleHome } from "@/lib/auth";
import { ClinicalDesk } from "@/components/clinical-desk";
import { Shell } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import { isPatientUuid } from "@/lib/qr";

export const metadata = { title: "Clinical Desk" };

export default async function ClinicalPage({
  searchParams,
}: {
  searchParams: Promise<{ scan?: string }>;
}) {
  const { profile } = await getSessionProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "clinical_operator" && profile.role !== "admin") {
    redirect(roleHome(profile.role) || "/");
  }

  const params = await searchParams;
  const scanRaw = params.scan?.trim().toLowerCase() ?? "";
  const initialScan = isPatientUuid(scanRaw) ? scanRaw : null;
  // Admin may view but mutations are operator-only (audit path is separate).
  const canMutate = profile.role === "clinical_operator";

  return (
    <Shell
      title="Clinical Desk"
      subtitle="Operational transcription from the signed paper prescription"
      roleLabel={profile.role === "admin" ? "Admin" : "Clinical"}
      backHref={profile.role === "admin" ? "/admin" : undefined}
      width="xl"
      actions={<SignOutButton place="header" />}
      dock={[{ href: roleHome(profile.role) || "/", label: "Home", primary: true }]}
    >
      <ClinicalDesk canMutate={canMutate} initialScan={initialScan} />
    </Shell>
  );
}
