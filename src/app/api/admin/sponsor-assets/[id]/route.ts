import { NextResponse } from "next/server";
import { loadSessionProfile } from "@/lib/auth";
import { isAdmin, isStaff } from "@/lib/roles";
import { isPatientUuid } from "@/lib/qr";
import { createServiceRoleClient } from "@/lib/supabase/admin";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { profile } = await loadSessionProfile();
  if (!isStaff(profile?.role)) return new NextResponse(null, { status: 404 });
  const { id } = await params;
  const admin = createServiceRoleClient();
  if (!admin) return new NextResponse(null, { status: 503 });
  const { data: asset } = await admin
    .from("sponsor_assets")
    .select("object_key,mime_type,state")
    .eq("id", id)
    .maybeSingle();
  if (!asset || asset.state !== "ready") return new NextResponse(null, { status: 404 });
  const { data, error } = await admin.storage
    .from("prescription-sponsors")
    .download(asset.object_key);
  if (error || !data) return new NextResponse(null, { status: 404 });
  return new NextResponse(await data.arrayBuffer(), {
    headers: {
      "Content-Type": asset.mime_type,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { profile } = await loadSessionProfile();
  if (!isAdmin(profile?.role)) return new NextResponse(null, { status: 404 });
  const { id } = await params;
  if (!isPatientUuid(id)) return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  const admin = createServiceRoleClient();
  if (!admin) return NextResponse.json({ error: "Asset service unavailable." }, { status: 503 });
  const { data: beginData, error: beginError } = await admin.rpc(
    "begin_sponsor_asset_deletion",
    { p_asset_id: id },
  );
  if (beginError) {
    const message = String(beginError.message ?? "");
    if (/not found/i.test(message)) {
      return NextResponse.json({ error: "Asset not found." }, { status: 404 });
    }
    if (/referenced by a template/i.test(message)) {
      return NextResponse.json(
        { error: "Remove this logo from every draft and published template first." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "Asset deletion could not start." }, { status: 409 });
  }

  const beginRow = (Array.isArray(beginData) ? beginData[0] : beginData) as
    | { object_key?: string; state?: string }
    | null;
  if (!beginRow?.object_key || beginRow.state !== "deleting") {
    return NextResponse.json({ error: "Asset deletion could not start." }, { status: 409 });
  }

  const { error: storageError } = await admin.storage
    .from("prescription-sponsors")
    .remove([beginRow.object_key]);
  const storageNotFound =
    storageError && /not found|not_found|404/i.test(String(storageError.message ?? storageError));
  if (storageError && !storageNotFound) {
    const { data: current } = await admin
      .from("sponsor_assets")
      .select("cleanup_attempts")
      .eq("id", id)
      .eq("state", "deleting")
      .maybeSingle();
    await admin
      .from("sponsor_assets")
      .update({
        cleanup_attempts: Number(current?.cleanup_attempts ?? 0) + 1,
        last_error_code: "STORAGE_DELETE_FAILED",
      })
      .eq("id", id)
      .eq("state", "deleting");
    return NextResponse.json(
      { error: "Asset storage could not be removed. Retry deletion." },
      { status: 502 },
    );
  }

  const { error: finishError } = await admin.rpc("finish_sponsor_asset_deletion", {
    p_asset_id: id,
  });
  if (finishError) {
    return NextResponse.json(
      { error: "Asset record could not be removed. Retry deletion." },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
