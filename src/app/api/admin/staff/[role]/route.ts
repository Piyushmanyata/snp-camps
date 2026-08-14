import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { loadSessionProfile, readJsonBody } from "@/lib/auth";
import { mapDbError } from "@/lib/public-error";
import { generateStaffPassword } from "@/lib/staff-password";

export type StaffRole = "volunteer" | "team_lead" | "clinical_operator";

const STAFF_ROLES = new Set<string>([
  "volunteer",
  "team_lead",
  "clinical_operator",
]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function roleLabel(role: StaffRole): string {
  if (role === "team_lead") return "Team Lead";
  if (role === "clinical_operator") return "Clinical Desk Operator";
  return "Volunteer";
}

const SAFE_RECONCILIATION_CODE = "RECONCILIATION_REQUIRED";

function reconciliationResponse(label: string) {
  return NextResponse.json(
    {
      ok: false,
      code: SAFE_RECONCILIATION_CODE,
      error: `${label} account needs reconciliation before it can be retried.`,
    },
    { status: 503 },
  );
}

async function parseRole(
  params: Promise<{ role: string }>,
): Promise<StaffRole | NextResponse> {
  const { role: raw } = await params;
  if (!STAFF_ROLES.has(raw)) {
    return NextResponse.json({ error: "Invalid staff role" }, { status: 400 });
  }
  return raw as StaffRole;
}

async function requireStaffManager(
  role: StaffRole,
): Promise<{ userId: string; scopeTeamLeadId: string | null } | { error: NextResponse }> {
  const { userId, profile } = await loadSessionProfile();
  if (!userId) {
    return { error: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  }
  if (profile?.role === "admin") {
    return { userId, scopeTeamLeadId: null };
  }
  if (profile?.role === "team_lead" && role === "volunteer") {
    return { userId, scopeTeamLeadId: userId };
  }
  return {
    error: NextResponse.json(
      { error: "You can only manage volunteers on your own team" },
      { status: 403 },
    ),
  };
}

type RouteCtx = { params: Promise<{ role: string }> };

export async function GET(_req: Request, { params }: RouteCtx) {
  const roleOrErr = await parseRole(params);
  if (roleOrErr instanceof NextResponse) return roleOrErr;

  const role = roleOrErr;
  const auth = await requireStaffManager(role);
  if ("error" in auth) return auth.error;

  const scoped = auth.scopeTeamLeadId;
  const supabase = scoped ? createServiceRoleClient() : await createClient();
  if (!supabase) {
    return NextResponse.json({ error: "Account service is unavailable" }, { status: 500 });
  }

  let query = supabase
    .from("profiles")
    .select("id, full_name, email, phone, role, created_at, disabled_at")
    .eq("role", role);
  if (scoped) query = query.eq("team_lead_id", scoped);

  const { data, error } = await query.order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      {
        error: mapDbError(error, {
          context: `admin-staff.${role}.list`,
          fallback: "Staff list could not be loaded. Try again.",
        }),
      },
      { status: 400 },
    );
  }

  return NextResponse.json({ staff: data || [] });
}

export async function POST(req: Request, { params }: RouteCtx) {
  const roleOrErr = await parseRole(params);
  if (roleOrErr instanceof NextResponse) return roleOrErr;

  const role = roleOrErr;
  const auth = await requireStaffManager(role);
  if ("error" in auth) return auth.error;

  const label = roleLabel(role);

  const body = await readJsonBody<{
    fullName?: string;
    email?: string;
    teamLeadId?: string | null;
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
  if (role !== "volunteer" && body.teamLeadId !== undefined) {
    return NextResponse.json(
      { error: "Team assignment is only valid for volunteers" },
      { status: 400 },
    );
  }

  const requestedTeamLeadId =
    body.teamLeadId == null ? null : String(body.teamLeadId).trim();
  if (
    auth.scopeTeamLeadId &&
    requestedTeamLeadId &&
    requestedTeamLeadId !== auth.scopeTeamLeadId
  ) {
    return NextResponse.json(
      { error: "You can only add volunteers to your own team" },
      { status: 403 },
    );
  }
  const assignedTeamLeadId =
    auth.scopeTeamLeadId || requestedTeamLeadId || null;
  if (assignedTeamLeadId && !UUID_RE.test(assignedTeamLeadId)) {
    return NextResponse.json({ error: "Invalid Team Lead" }, { status: 400 });
  }

  const password = generateStaffPassword();

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Account service is unavailable" },
      { status: 500 },
    );
  }
  if (assignedTeamLeadId && !auth.scopeTeamLeadId) {
    const { data: lead, error: leadError } = await admin
      .from("profiles")
      .select("id")
      .eq("id", assignedTeamLeadId)
      .eq("role", "team_lead")
      .is("disabled_at", null)
      .maybeSingle();
    if (leadError || !lead) {
      return NextResponse.json(
        { error: "Choose an active Team Lead" },
        { status: 400 },
      );
    }
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createErr) {
    const msg = createErr.message.toLowerCase();
    if (msg.includes("already")) {
      const { data: existingProfile, error: existingProfileError } = await admin
        .from("profiles")
        .select("id, role, disabled_at")
        .eq("email", email)
        .maybeSingle();
      if (existingProfileError) {
        return NextResponse.json(
          { error: `${label} account could not be checked. Try again.` },
          { status: 502 },
        );
      }
      if (existingProfile) {
        return NextResponse.json(
          {
            error:
              "That email is already registered. Share their existing login or use a different email.",
          },
          { status: 409 },
        );
      }

      const { data: users, error: usersError } = await admin.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      if (usersError) {
        return NextResponse.json(
          { error: `${label} account could not be reconciled. Try again.` },
          { status: 502 },
        );
      }
      const orphan = users.users.find(
        (user) => user.email?.trim().toLowerCase() === email,
      );
      if (!orphan) {
        return NextResponse.json(
          {
            error:
              "That email is already registered. Share their existing login or use a different email.",
          },
          { status: 409 },
        );
      }

      const { error: updateOrphanError } = await admin.auth.admin.updateUserById(
        orphan.id,
        {
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName },
        },
      );
      if (updateOrphanError) {
        console.error("[admin-staff] orphan Auth user update failed", {
          authUserId: orphan.id,
          code: updateOrphanError.code,
        });
        return reconciliationResponse(label);
      }

      const { error: reconciledProfileError } = await admin
        .from("profiles")
        .insert({
          id: orphan.id,
          role,
          full_name: fullName,
          email,
          team_lead_id: assignedTeamLeadId,
        });
      if (reconciledProfileError) {
        console.error("[admin-staff] orphan profile reconciliation failed", {
          authUserId: orphan.id,
          code: reconciledProfileError.code,
        });
        return reconciliationResponse(label);
      }

      return NextResponse.json(
        {
          ok: true,
          reconciled: true,
          temporaryPassword: password,
          staff: {
            id: orphan.id,
            full_name: fullName,
            email,
            role,
            team_lead_id: assignedTeamLeadId,
          },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      {
        error: mapDbError(createErr, {
          context: `admin-staff.${role}.create-user`,
          fallback: `${label} account could not be created. Try again.`,
        }),
      },
      { status: 400 },
    );
  }

  if (!created.user) {
    return NextResponse.json({ error: "No user created" }, { status: 400 });
  }

  const { error: profileErr } = await admin.from("profiles").insert({
    id: created.user.id,
    role,
    full_name: fullName,
    email,
    team_lead_id: assignedTeamLeadId,
  });

  if (profileErr) {
    const { error: rollbackError } = await admin.auth.admin.deleteUser(created.user.id);
    if (rollbackError) {
      console.error("[admin-staff] Auth rollback failed", {
        authUserId: created.user.id,
        code: rollbackError.code,
      });
      return reconciliationResponse(label);
    }
    return NextResponse.json(
      { error: `${label} account could not be provisioned. Try again.` },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      temporaryPassword: password,
      staff: {
        id: created.user.id,
        full_name: fullName,
        email,
        role,
        team_lead_id: assignedTeamLeadId,
      },
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function PATCH(req: Request, { params }: RouteCtx) {
  const roleOrErr = await parseRole(params);
  if (roleOrErr instanceof NextResponse) return roleOrErr;

  const role = roleOrErr;
  const auth = await requireStaffManager(role);
  if ("error" in auth) return auth.error;

  const label = roleLabel(role);

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
      { error: `Valid ${role} id required` },
      { status: 400 },
    );
  }
  if (action !== "reset_password" && action !== "reactivate") {
    return NextResponse.json(
      { error: `Invalid ${role} action` },
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

  let profileQuery = admin
    .from("profiles")
    .select("id, full_name, email, role, disabled_at")
    .eq("id", id);
  if (auth.scopeTeamLeadId) profileQuery = profileQuery.eq("team_lead_id", auth.scopeTeamLeadId);
  const { data: profile, error: profileError } = await profileQuery.maybeSingle();

  if (profileError) {
    return NextResponse.json(
      { error: `${label} account could not be checked.` },
      { status: 500 },
    );
  }
  if (!profile || profile.role !== role) {
    return NextResponse.json({ error: `${label} not found` }, { status: 404 });
  }

  if (action === "reactivate") {
    const disabledAt = profile.disabled_at;
    const { error: unbanError } = await admin.auth.admin.updateUserById(id, {
      ban_duration: "none",
    });
    if (unbanError) {
      return NextResponse.json(
        { error: `${label} sign-in could not be reactivated. Try again.` },
        { status: 500 },
      );
    }

    if (!disabledAt) {
      return NextResponse.json({
        ok: true,
        staff: { ...profile, disabled_at: null },
      });
    }

    const { data: reactivated, error: reactivateError } = await admin
      .from("profiles")
      .update({ disabled_at: null })
      .eq("id", id)
      .eq("role", role)
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
            ? `${label} profile stayed disabled, but the sign-in ban could not be restored. Retry deactivation immediately.`
            : `${label} account changed during reactivation. Refresh and retry.`,
        },
        { status: reactivateError || rebanError ? 500 : 409 },
      );
    }

    return NextResponse.json({ ok: true, staff: reactivated });
  }

  if (profile.disabled_at) {
    return NextResponse.json(
      { error: `Active ${role} not found` },
      { status: 404 },
    );
  }

  const temporaryPassword = generateStaffPassword();
  const { error: resetError } = await admin.auth.admin.updateUserById(id, {
    password: temporaryPassword,
  });
  if (resetError) {
    return NextResponse.json(
      { error: `${label} password could not be reset. Try again.` },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      temporaryPassword,
      staff: {
        id: profile.id,
        full_name: profile.full_name,
        email: profile.email,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(req: Request, { params }: RouteCtx) {
  const roleOrErr = await parseRole(params);
  if (roleOrErr instanceof NextResponse) return roleOrErr;

  const role = roleOrErr;
  const auth = await requireStaffManager(role);
  if ("error" in auth) return auth.error;

  const label = roleLabel(role);

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
    return NextResponse.json(
      { error: `Valid ${role} id required` },
      { status: 400 },
    );
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

  let loadQuery = admin.from("profiles").select("id, role, disabled_at").eq("id", id);
  if (auth.scopeTeamLeadId) loadQuery = loadQuery.eq("team_lead_id", auth.scopeTeamLeadId);
  const { data: profile, error: pErr } = await loadQuery.maybeSingle();

  if (pErr) {
    return NextResponse.json(
      {
        error: mapDbError(pErr, {
          context: `admin-staff.${role}.load`,
          fallback: `${label} could not be loaded. Try again.`,
        }),
      },
      { status: 400 },
    );
  }
  if (!profile || profile.role !== role) {
    return NextResponse.json({ error: `${label} not found` }, { status: 404 });
  }

  let disabledAt = profile.disabled_at;
  let changedByThisRequest = false;
  if (!disabledAt) {
    const candidate = new Date().toISOString();
    const { data: disabled, error: disableErr } = await admin
      .from("profiles")
      .update({ disabled_at: candidate })
      .eq("id", id)
      .eq("role", role)
      .is("disabled_at", null)
      .select("disabled_at")
      .maybeSingle();
    if (disableErr) {
      return NextResponse.json(
        { error: `${label} account could not be deactivated.` },
        { status: 500 },
      );
    }
    disabledAt = disabled?.disabled_at ?? null;
    changedByThisRequest = Boolean(disabledAt);
    if (!disabledAt) {
      return NextResponse.json(
        {
          error: `${label} account changed during deactivation. Refresh and retry.`,
        },
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
            ? `${label} sign-in could not be disabled; the profile change was rolled back.`
            : `${label} remains deactivated, but the sign-in ban could not be confirmed. Retry to enforce the ban.`,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, id, disabledAt });
}
