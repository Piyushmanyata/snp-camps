import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { readJsonBody, requireAdmin } from "@/lib/auth";

/** Shareable invite password: 14 chars, no ambiguous glyphs. */
function generateInvitePassword(length = 14): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

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
  let password = String(body.password || "");
  const autoPassword = !password;
  if (autoPassword) {
    password = generateInvitePassword(14);
  }

  if (!fullName || !email) {
    return NextResponse.json(
      { error: "Name and email are required" },
      { status: 400 },
    );
  }
  if (password.length < 12) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters (or leave blank to auto-generate)" },
      { status: 400 },
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Account service is unavailable" },
      { status: 500 },
    );
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createErr) {
    const msg = createErr.message.toLowerCase();
    return NextResponse.json(
      {
        error: msg.includes("already")
          ? "That email is already registered. Share their existing login or use a different email."
          : createErr.message,
      },
      { status: 400 },
    );
  }

  if (!created.user) {
    return NextResponse.json({ error: "No user created" }, { status: 400 });
  }

  const { error: profileErr } = await admin.from("profiles").upsert({
    id: created.user.id,
    role: "volunteer",
    full_name: fullName,
    email,
  });

  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json(
      { error: "Volunteer account could not be provisioned. Try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    invitePassword: password,
    autoPassword,
    volunteer: {
      id: created.user.id,
      full_name: fullName,
      email,
      role: "volunteer",
    },
  });
}

export async function DELETE(req: Request) {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const url = new URL(req.url);
  let id = url.searchParams.get("id")?.trim() || "";
  if (!id) {
    const body = await readJsonBody<{ id?: string }>(req);
    id = String(body?.id || "").trim();
  }

  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    return NextResponse.json({ error: "Valid volunteer id required" }, { status: 400 });
  }

  if (id === auth.userId) {
    return NextResponse.json(
      { error: "You cannot delete your own account" },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Account service is unavailable" },
      { status: 500 },
    );
  }

  const { data: profile, error: pErr } = await admin
    .from("profiles")
    .select("id, role")
    .eq("id", id)
    .maybeSingle();

  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 400 });
  }
  if (!profile || profile.role !== "volunteer") {
    return NextResponse.json(
      { error: "Volunteer not found" },
      { status: 404 },
    );
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(id);
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, id });
}