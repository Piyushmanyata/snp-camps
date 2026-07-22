import { NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { readJsonBody, requireAdmin } from "@/lib/auth";

/** Shareable temporary password: 14 chars, no ambiguous glyphs. */
function generateTemporaryPassword(length = 14): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet.charAt(randomInt(alphabet.length));
  }
  return out;
}

export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, phone, role, created_at, disabled_at")
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
  }>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fullName = String(body.fullName || "").trim();
  const email = String(body.email || "").trim().toLowerCase();

  if (!fullName || !email) {
    return NextResponse.json(
      { error: "Name and email are required" },
      { status: 400 },
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }
  const password = generateTemporaryPassword();

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
    temporaryPassword: password,
    volunteer: {
      id: created.user.id,
      full_name: fullName,
      email,
      role: "volunteer",
    },
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PATCH(req: Request) {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const body = await readJsonBody<{
    id?: string;
    action?: "reset_password" | "reactivate";
  }>(req);
  const id = String(body?.id || "").trim();
  const action = body?.action ?? "reset_password";
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    return NextResponse.json(
      { error: "Valid volunteer id required" },
      { status: 400 },
    );
  }
  if (action !== "reset_password" && action !== "reactivate") {
    return NextResponse.json(
      { error: "Invalid volunteer action" },
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

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, full_name, email, role, disabled_at")
    .eq("id", id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json(
      { error: "Volunteer account could not be checked." },
      { status: 500 },
    );
  }
  if (!profile || profile.role !== "volunteer") {
    return NextResponse.json({ error: "Volunteer not found" }, { status: 404 });
  }

  if (action === "reactivate") {
    const disabledAt = profile.disabled_at;
    const { error: unbanError } = await admin.auth.admin.updateUserById(id, {
      ban_duration: "none",
    });
    if (unbanError) {
      return NextResponse.json(
        { error: "Volunteer sign-in could not be reactivated. Try again." },
        { status: 500 },
      );
    }

    if (!disabledAt) {
      return NextResponse.json({
        ok: true,
        volunteer: { ...profile, disabled_at: null },
      });
    }

    const { data: reactivated, error: reactivateError } = await admin
      .from("profiles")
      .update({ disabled_at: null })
      .eq("id", id)
      .eq("role", "volunteer")
      .eq("disabled_at", disabledAt)
      .select("id, full_name, email, phone, role, created_at, disabled_at")
      .maybeSingle();

    if (reactivateError || !reactivated) {
      const { error: rebanError } = await admin.auth.admin.updateUserById(id, {
        ban_duration: "876000h",
      });
      return NextResponse.json(
        {
          error: rebanError
            ? "Volunteer profile stayed disabled, but the sign-in ban could not be restored. Retry deactivation immediately."
            : "Volunteer account changed during reactivation. Refresh and retry.",
        },
        { status: reactivateError || rebanError ? 500 : 409 },
      );
    }

    return NextResponse.json({ ok: true, volunteer: reactivated });
  }

  if (profile.disabled_at) {
    return NextResponse.json(
      { error: "Active volunteer not found" },
      { status: 404 },
    );
  }

  const temporaryPassword = generateTemporaryPassword();
  const { error: resetError } = await admin.auth.admin.updateUserById(id, {
    password: temporaryPassword,
  });
  if (resetError) {
    return NextResponse.json(
      { error: "Volunteer password could not be reset. Try again." },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      temporaryPassword,
      volunteer: {
        id: profile.id,
        full_name: profile.full_name,
        email: profile.email,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
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
      { error: "You cannot deactivate your own account" },
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
    .select("id, role, disabled_at")
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

  let disabledAt = profile.disabled_at;
  let changedByThisRequest = false;
  if (!disabledAt) {
    const candidate = new Date().toISOString();
    const { data: disabled, error: disableErr } = await admin
      .from("profiles")
      .update({ disabled_at: candidate })
      .eq("id", id)
      .eq("role", "volunteer")
      .is("disabled_at", null)
      .select("disabled_at")
      .maybeSingle();
    if (disableErr) {
      return NextResponse.json(
        { error: "Volunteer account could not be deactivated." },
        { status: 500 },
      );
    }
    disabledAt = disabled?.disabled_at ?? null;
    changedByThisRequest = Boolean(disabledAt);
    if (!disabledAt) {
      return NextResponse.json(
        { error: "Volunteer account changed during deactivation. Refresh and retry." },
        { status: 409 },
      );
    }
  }

  const { error: banErr } = await admin.auth.admin.updateUserById(id, {
    ban_duration: "876000h",
  });
  if (banErr) {
    let rollbackFailed = false;
    if (changedByThisRequest) {
      const { error: rollbackError } = await admin
        .from("profiles")
        .update({ disabled_at: null })
        .eq("id", id)
        .eq("disabled_at", disabledAt);
      rollbackFailed = Boolean(rollbackError);
    }
    return NextResponse.json(
      {
        error:
          changedByThisRequest && !rollbackFailed
            ? "Volunteer sign-in could not be disabled; the profile change was rolled back."
            : "Volunteer remains deactivated, but the sign-in ban could not be confirmed. Retry to enforce the ban.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, id, disabledAt });
}
