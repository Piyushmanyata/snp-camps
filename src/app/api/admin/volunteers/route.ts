import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { readJsonBody, requireAdmin } from "@/lib/auth";

export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, phone, role, created_at")
    .eq("role", "volunteer")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ volunteers: data || [] });
}

export async function POST(req: Request) {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const body = await readJsonBody<{
    fullName?: string;
    email?: string;
    password?: string;
  }>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fullName = String(body.fullName || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!fullName || !email || password.length < 6) {
    return NextResponse.json(
      { error: "Name, email, and password (min 6) required" },
      { status: 400 },
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, staff_role: "volunteer" },
  });

  if (createErr) {
    return NextResponse.json({ error: createErr.message }, { status: 400 });
  }

  if (!created.user) {
    return NextResponse.json({ error: "No user created" }, { status: 400 });
  }

  // Ensure profile is volunteer (trigger may have created patient role first)
  const { error: profileErr } = await admin.from("profiles").upsert({
    id: created.user.id,
    role: "volunteer",
    full_name: fullName,
    email,
  });

  if (profileErr) {
    return NextResponse.json({ error: profileErr.message }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    volunteer: {
      id: created.user.id,
      full_name: fullName,
      email,
      role: "volunteer",
    },
  });
}
