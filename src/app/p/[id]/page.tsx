import { redirect } from "next/navigation";
import { getSessionProfile, isCampCrew, roleHome } from "@/lib/auth";
import { isPatientUuid } from "@/lib/qr";

/**
 * Staff-scan QR entry — `/p/{uuid}`.
 * Camp crew → their desk with ?scan=. Anyone else → plain show-at-desk message.
 * Never logs patients in. Not the passwordless status link (/s/<token>).
 */
export default async function PatientScanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = rawId.trim().toLowerCase();

  if (!isPatientUuid(id)) {
    return (
      <main id="main" className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-lg font-semibold">Invalid code</h1>
        <p className="mt-2 text-sm text-muted">
          Show this screen at the camp desk.
        </p>
      </main>
    );
  }

  const { profile } = await getSessionProfile();
  if (!isCampCrew(profile?.role)) {
    return (
      <main id="main" className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-lg font-semibold">Camp desk scan only</h1>
        <p className="mt-2 text-sm text-muted">
          This QR is for camp staff. Show it at the volunteer desk.
        </p>
      </main>
    );
  }

  const deskBase = roleHome(profile?.role) || "/volunteer";

  redirect(`${deskBase}?scan=${id}`);
}
