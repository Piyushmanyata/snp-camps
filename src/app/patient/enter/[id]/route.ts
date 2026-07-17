import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { patientAuthEmail } from "@/lib/patient-auth";
import { verifyPatientQrToken } from "@/lib/patient-qr";

/**
 * Passwordless patient QR entry.
 * Patient scans QR → instant session → /patient.
 * Staff logged in → join queue (not print/seen yet) → volunteer desk.
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

  if (!uuidOk || !verifyPatientQrToken(id, token)) {
    return NextResponse.redirect(
      new URL("/patient/login?error=invalid_qr", origin),
    );
  }

  // Desk staff: auto add to queue (scan = queue). Print separately marks seen.
  const { profile } = await getSessionProfile();
  if (isStaff(profile?.role)) {
    try {
      const supabase = await createClient();
      await supabase.rpc("join_queue", {
        p_patient_id: id,
        p_reg_no: null,
      });
    } catch {
      /* still send staff to desk */
    }
    return NextResponse.redirect(
      new URL(`/volunteer?checkin=${id}`, origin),
    );
  }

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.redirect(
      new URL("/patient/login?error=server", origin),
    );
  }

  const { data: patient } = await admin
    .from("patients")
    .select("id, reg_no, full_name, user_id")
    .eq("id", id)
    .maybeSingle();

  if (!patient) {
    return NextResponse.redirect(
      new URL("/patient/login?error=not_found", origin),
    );
  }

  const email = patientAuthEmail(patient.reg_no);
  const name = patient.full_name || `Patient ${patient.reg_no}`;

  // Ensure auth user exists and is linked
  let userId = patient.user_id as string | null;
  if (!userId) {
    const password = randomBytes(24).toString("base64url");
    const { data: created, error: createErr } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: name,
          patient_reg_no: patient.reg_no,
        },
      });

    if (createErr && /already|registered|exists/i.test(createErr.message)) {
      const { data: existingProfile } = await admin
        .from("profiles")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      if (!existingProfile?.id) {
        return NextResponse.redirect(
          new URL("/patient/login?error=account", origin),
        );
      }
      userId = existingProfile.id;
    } else if (createErr || !created?.user) {
      return NextResponse.redirect(
        new URL("/patient/login?error=account", origin),
      );
    } else {
      userId = created.user.id;
    }

    await admin.from("profiles").upsert({
      id: userId,
      role: "patient",
      full_name: name,
      email,
    });
    await admin
      .from("patients")
      .update({ user_id: userId })
      .eq("id", id)
      .is("user_id", null);
  }

  // Establish session via one-time magic link hash (no email sent)
  const { data: linkData, error: linkErr } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });

  const hashed = linkData?.properties?.hashed_token;
  if (linkErr || !hashed) {
    return NextResponse.redirect(
      new URL("/patient/login?error=session", origin),
    );
  }

  // Cookies must be written onto the redirect response
  const redirectTo = NextResponse.redirect(new URL("/patient", origin));
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anon) {
    return NextResponse.redirect(
      new URL("/patient/login?error=server", origin),
    );
  }

  const supabase = createServerClient(supabaseUrl, anon, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          redirectTo.cookies.set(name, value, options);
        });
      },
    },
  });

  const { error: otpErr } = await supabase.auth.verifyOtp({
    type: "email",
    token_hash: hashed,
  });

  if (otpErr) {
    return NextResponse.redirect(
      new URL("/patient/login?error=session", origin),
    );
  }

  return redirectTo;
}
