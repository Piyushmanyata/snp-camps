import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { readJsonBody } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

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
  const rate = checkRateLimit(req, {
    scope: "staff-register",
    identifier: email || "missing-email",
    limit: 5,
    windowMs: 15 * 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many registration attempts. Try again later." },
      { status: 429, headers: rate.headers },
    );
  }

  if (!fullName || !email || !password || !invite) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (password.length < 12) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters" },
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
    if (!configured) return false;
    const bufProvided = Buffer.from(provided);
    const bufConfigured = Buffer.from(configured);
    if (bufProvided.byteLength !== bufConfigured.byteLength) return false;
    return timingSafeEqual(bufProvided, bufConfigured);
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

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Staff provisioning is not configured on this server" },
      { status: 500 },
    );
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (error) {
    return NextResponse.json(
      { error: "Could not create account. The email may already be in use." },
      { status: 400 },
    );
  }

  if (!data.user) {
    return NextResponse.json({ error: "No user created" }, { status: 400 });
  }

  const { error: profileErr } = await admin
    .from("profiles")
    .update({ role, full_name: fullName, email })
    .eq("id", data.user.id);
  if (profileErr) {
    await admin.auth.admin.deleteUser(data.user.id);
    return NextResponse.json(
      { error: "Staff account could not be provisioned. Try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, role });
}
