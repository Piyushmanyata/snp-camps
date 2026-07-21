import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { readJsonBody } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

function normalizeInvite(value: string) {
  return value.normalize("NFC").trim();
}

function usableInvite(value: string | undefined, placeholder: string) {
  return Boolean(value && value.length >= 12 && value !== placeholder);
}

/** Case-insensitive timing-safe compare of invite codes. */
function matchesInvite(provided: string, configured: string | undefined) {
  if (!configured) return false;
  const a = Buffer.from(normalizeInvite(provided).toLowerCase());
  const b = Buffer.from(normalizeInvite(configured).toLowerCase());
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

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
  const invite = normalizeInvite(String(body.invite || ""));
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

  const volunteerCode = process.env.VOLUNTEER_INVITE_CODE;
  if (!usableInvite(volunteerCode, "change-me-volunteer")) {
    return NextResponse.json(
      {
        error:
          "Invite codes are not configured on the server. Ask an admin to create your account and share login credentials instead.",
      },
      { status: 500 },
    );
  }

  if (!matchesInvite(invite, volunteerCode)) {
    return NextResponse.json(
      {
        error:
          "Invalid invite code. Check for typos, or ask admin to create your account and share email + invite password.",
      },
      { status: 403 },
    );
  }
  const role = "volunteer" as const;

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
      {
        error:
          "Could not create account. The email may already be in use — ask admin to share your invite password for that email, then sign in and change the password.",
      },
      { status: 400 },
    );
  }

  if (!data.user) {
    return NextResponse.json({ error: "No user created" }, { status: 400 });
  }

  const { error: profileErr } = await admin
    .from("profiles")
    .upsert({ id: data.user.id, role, full_name: fullName, email });
  if (profileErr) {
    await admin.auth.admin.deleteUser(data.user.id);
    return NextResponse.json(
      { error: "Staff account could not be provisioned. Try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, role });
}