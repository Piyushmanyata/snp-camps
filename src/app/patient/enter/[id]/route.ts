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

  // Clone the request URL so redirects keep the same host/port the client used
  // (127.0.0.1 vs localhost matter for cookies). Absolute SITE_URL would bounce
  // a local desk session to production and drop auth.
  function redirectTo(pathWithQuery: string) {
    const url = req.nextUrl.clone();
    const [pathname, search = ""] = pathWithQuery.split("?");
    url.pathname = pathname;
    url.search = search ? `?${search}` : "";
    return NextResponse.redirect(url);
  }

  if (!isPatientUuid(id)) {
    return redirectTo("/patient/qr-help?invalid=1");
  }

  const { profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) {
    return redirectTo(`/patient/qr-help?id=${encodeURIComponent(id)}`);
  }

  const deskBase =
    profile?.role === "admin"
      ? "/admin"
      : profile?.role === "doctor"
        ? "/doctor"
        : "/volunteer";

  return redirectTo(`${deskBase}?scan=${id}`);
}
