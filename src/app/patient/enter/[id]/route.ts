import { NextResponse, type NextRequest } from "next/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { isPatientUuid } from "@/lib/qr";

/**
 * Staff-scan QR entry — never logs patients in.
 *
 * Staff (volunteer / doctor / admin) are routed to their own desk. The scanner
 * performs a read-only lookup; patient state changes only after confirmation.
 *
 * Anyone else → “show this at the desk” help page.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await params;
  const id = rawId.trim().toLowerCase();
  const origin = process.env.NEXT_PUBLIC_SITE_URL || req.nextUrl.origin;

  if (!isPatientUuid(id)) {
    return NextResponse.redirect(new URL("/patient/qr-help?invalid=1", origin));
  }

  const { profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) {
    return NextResponse.redirect(
      new URL(`/patient/qr-help?id=${encodeURIComponent(id)}`, origin),
    );
  }

  const deskBase =
    profile?.role === "admin"
      ? "/admin"
      : profile?.role === "doctor"
        ? "/doctor"
        : "/volunteer";

  return NextResponse.redirect(new URL(`${deskBase}?scan=${id}`, origin));
}
