import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  const body = await req.json();
  const fullName = String(body.fullName || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const invite = String(body.invite || "").trim();

  if (!fullName || !email || !password || !invite) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  let role: "admin" | "volunteer" | null = null;
  if (invite === process.env.ADMIN_INVITE_CODE) role = "admin";
  else if (invite === process.env.VOLUNTEER_INVITE_CODE) role = "volunteer";
  else {
    return NextResponse.json({ error: "Invalid invite code" }, { status: 403 });
  }

  // Public signup — role elevated after insert (requires schema applied)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, staff_role: role } },
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (!data.user) {
    return NextResponse.json({ error: "No user created" }, { status: 400 });
  }

  // Elevate role — needs either service role or temporary open policy.
  // Prefer service role if present; else try update (admin invite bootstrap).
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceKey) {
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey);
    await admin.from("profiles").update({ role, full_name: fullName, email }).eq("id", data.user.id);
  } else {
    // Client update own profile right after signup — blocked by RLS for role.
    // Use RPC that checks invite via metadata (created below in schema note).
    const authed = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    // Session from signUp may exist
    if (data.session) {
      await authed.auth.setSession(data.session);
      await authed.rpc("claim_staff_role", {
        p_role: role,
        p_name: fullName,
      });
    }
  }

  return NextResponse.json({ ok: true, role });
}
