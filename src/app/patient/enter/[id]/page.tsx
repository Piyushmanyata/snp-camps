import { redirect } from "next/navigation";
import { getSessionProfile, isCampCrew } from "@/lib/auth";
import { isPatientUuid } from "@/lib/qr";

/**
 * Camp-crew QR entry — never logs patients in.
 *
 * Camp crew (volunteer / doctor / admin) are routed to their own desk. The
 * scanner performs a read-only lookup; patient state changes only after
 * confirmation.
 *
 * Anyone else → "show this at the desk" help page.
 *
 * Server Component page (not Route Handler) so session cookies use the same
 * next/headers path as role desks.
 */
export default async function PatientEnterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = rawId.trim().toLowerCase();

  if (!isPatientUuid(id)) {
    redirect("/patient/qr-help?invalid=1");
  }

  const { profile } = await getSessionProfile();
  if (!isCampCrew(profile?.role)) {
    redirect(`/patient/qr-help?id=${encodeURIComponent(id)}`);
  }

  const deskBase =
    profile?.role === "admin"
      ? "/admin"
      : profile?.role === "doctor"
        ? "/doctor"
        : "/volunteer";

  redirect(`${deskBase}?scan=${id}`);
}