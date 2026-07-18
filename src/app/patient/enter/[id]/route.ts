import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { verifyPatientQrToken } from "@/lib/patient-qr";

/**
 * Staff-scan QR entry (no patient login).
 * Routes by queue status:
 * - registered → print (joins queue)
 * - waiting → volunteer/doctor desk for assign
 * - seen → desk with already-seen notice
 * Unauthenticated: show “bring this to the desk” page.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = req.nextUrl.searchParams.get("t");
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL || req.nextUrl.origin;

  const uuidOk =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id,
    );

  // Accept signed tokens or plain UUID/print links (token optional for legacy)
  if (!uuidOk) {
    return NextResponse.redirect(
      new URL("/?notice=invalid_qr", origin),
    );
  }
  if (token && !verifyPatientQrToken(id, token)) {
    return NextResponse.redirect(
      new URL("/?notice=invalid_qr", origin),
    );
  }

  const { profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) {
    // Patients must not auto-login; tell them to show QR at desk
    return NextResponse.redirect(
      new URL(`/patient/qr-help?id=${id}`, origin),
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("lookup_patient_scan", {
    p_patient_id: id,
    p_reg_no: null,
  });
  if (error) {
    const fallback =
      profile?.role === "doctor" ? "/doctor" : "/volunteer";
    return NextResponse.redirect(new URL(`${fallback}?error=server`, origin));
  }
  const row = Array.isArray(data) ? data[0] : data;
  const status = row?.queue_status ?? null;

  if (status === "registered") {
    return NextResponse.redirect(new URL(`/print/${id}`, origin));
  }
  if (!status) {
    return NextResponse.redirect(new URL("/patient/login?error=not_found", origin));
  }

  // waiting or seen → staff desk with scan context
  const desk =
    profile?.role === "doctor"
      ? `/doctor?scan=${id}`
      : `/volunteer?scan=${id}`;
  return NextResponse.redirect(new URL(desk, origin));
}
