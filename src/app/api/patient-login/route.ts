import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { readJsonBody } from "@/lib/auth";
import { patientAuthEmail } from "@/lib/patient-auth";
import { isPasswordLongEnough } from "@/lib/patient-password";
import { parseRegistrationNumber } from "@/lib/qr";
import { checkRateLimit } from "@/lib/rate-limit";

type Body = {
  regNo?: number | string;
  /** Desk-slip passcode (Auth password for reg{N}@patients.snp.local). */
  passcode?: string;
  /** Accepted as an alias for passcode for older clients / e2e. */
  password?: string;
};

/** Same message for wrong reg, wrong passcode, missing account, disabled — no oracle. */
const INVALID =
  "Invalid registration number or passcode. Check your desk slip or ask the desk.";

/**
 * Patient sign-in with registration number + desk-slip passcode.
 *
 * Does not create users, reset passwords, or return credentials.
 * Passcodes are stored only as Supabase Auth password hashes.
 */
export async function POST(req: Request) {
  const body = await readJsonBody<Body>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const regNo = parseRegistrationNumber(body.regNo);
  const passcode = String(body.passcode ?? body.password ?? "").trim();

  const rate = checkRateLimit(req, {
    scope: "patient-login",
    identifier: regNo != null ? String(regNo) : "invalid",
    limit: 12,
    windowMs: 15 * 60_000,
  });
  const headers: Record<string, string> = {
    ...rate.headers,
    "Cache-Control": "no-store, max-age=0",
  };

  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429, headers },
    );
  }

  // Format failures use the same status/message as auth failures (no oracle).
  if (regNo === null || !passcode || !isPasswordLongEnough(passcode)) {
    return NextResponse.json({ error: INVALID }, { status: 401, headers });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return NextResponse.json(
      { error: "Login service is unavailable." },
      { status: 503, headers },
    );
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          /* Route Handler should allow set; ignore if called in a read-only context. */
        }
      },
    },
  });

  const email = patientAuthEmail(regNo);
  const { data: signIn, error: signErr } =
    await supabase.auth.signInWithPassword({
      email,
      password: passcode,
    });

  if (signErr || !signIn.user) {
    return NextResponse.json({ error: INVALID }, { status: 401, headers });
  }

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("role, disabled_at")
    .eq("id", signIn.user.id)
    .maybeSingle();

  if (
    profileErr ||
    !profile ||
    profile.disabled_at ||
    profile.role !== "patient"
  ) {
    await supabase.auth.signOut();
    return NextResponse.json({ error: INVALID }, { status: 401, headers });
  }

  return NextResponse.json(
    {
      ok: true,
      regNo,
      // Never return password/passcode/email secrets.
    },
    { status: 200, headers },
  );
}
