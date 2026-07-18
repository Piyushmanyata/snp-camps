import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
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
  const usable = (value: string | undefined, placeholder: string) =>
    Boolean(value && value.length >= 16 && value !== placeholder);
  const matches = (provided: string, configured: string | undefined) => {
    if (!configured || provided.length !== configured.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
  };
  if (
    !usable(adminCode, "change-me-admin") &&
    !usable(volunteerCode, "change-me-volunteer")
  ) {
    return NextResponse.json(
      { error: "Invite codes not configured on server" },
      { status: 500 },
    );
  }

  let role: "admin" | "volunteer" | null = null;
  if (usable(adminCode, "change-me-admin") && matches(invite, adminCode)) {
    role = "admin";
  } else if (
    usable(volunteerCode, "change-me-volunteer") &&
    matches(invite, volunteerCode)
  ) {
    role = "volunteer";
  }
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

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Staff provisioning is not configured on this server" },
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

  const { error: profileErr } = await admin
    .from("profiles")
    .update({ role, full_name: fullName, email })
    .eq("id", data.user.id);
  if (profileErr) {
    return NextResponse.json(
      { error: "Account created but staff role could not be provisioned" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, role });
}
