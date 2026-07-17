import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { readJsonBody } from "@/lib/auth";

export async function POST(req: Request) {
  const body = await readJsonBody<{
    fullName?: string;
    email?: string;
    password?: string;
    invite?: string;
  }>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fullName = String(body.fullName || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const invite = String(body.invite || "").trim();

  if (!fullName || !email || !password || !invite) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 },
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const adminCode = process.env.ADMIN_INVITE_CODE;
  const volunteerCode = process.env.VOLUNTEER_INVITE_CODE;
  if (!adminCode && !volunteerCode) {
    return NextResponse.json(
      { error: "Invite codes not configured on server" },
      { status: 500 },
    );
  }

  let role: "admin" | "volunteer" | null = null;
  if (adminCode && invite === adminCode) role = "admin";
  else if (volunteerCode && invite === volunteerCode) role = "volunteer";
  else {
    return NextResponse.json({ error: "Invalid invite code" }, { status: 403 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return NextResponse.json(
      { error: "Server missing Supabase config" },
      { status: 500 },
    );
  }

  const supabase = createClient(url, anon);
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

  const admin = createServiceRoleClient();
  if (admin) {
    await admin
      .from("profiles")
      .update({ role, full_name: fullName, email })
      .eq("id", data.user.id);
  } else if (data.session) {
    const authed = createClient(url, anon);
    await authed.auth.setSession(data.session);
    await authed.rpc("claim_staff_role", {
      p_role: role,
      p_name: fullName,
    });
  }

  return NextResponse.json({ ok: true, role });
}
