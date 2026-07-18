import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { isPatientUuid } from "@/lib/qr";

/**
 * Staff-scan QR entry — never logs patients in.
 *
 * Staff (volunteer / doctor / admin):
 * - registered → print (joins queue)
 * - waiting / seen → desk with ?scan= for assign UI
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
    return NextResponse.redirect(new URL("/?notice=invalid_qr", origin));
  }

  const { profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) {
    return NextResponse.redirect(
      new URL(`/patient/qr-help?id=${encodeURIComponent(id)}`, origin),
    );
  }

  const deskBase = profile?.role === "doctor" ? "/doctor" : "/volunteer";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("lookup_patient_scan", {
    p_patient_id: id,
    p_reg_no: null,
  });

  if (error) {
    return NextResponse.redirect(
      new URL(`${deskBase}?error=scan_lookup`, origin),
    );
  }

  const row = Array.isArray(data) ? data[0] : data;
  const status = row?.queue_status ?? null;

  if (!status) {
    return NextResponse.redirect(
      new URL(`${deskBase}?error=not_found`, origin),
    );
  }

  // registered → print joins queue; waiting/seen → desk assign UI
  if (status === "registered") {
    return NextResponse.redirect(new URL(`/print/${id}`, origin));
  }

  return NextResponse.redirect(new URL(`${deskBase}?scan=${id}`, origin));
}
