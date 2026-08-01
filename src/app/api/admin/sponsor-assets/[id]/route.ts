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
    .select("object_key,mime_type")
    .eq("id", id)
    .maybeSingle();
  if (!asset) return new NextResponse(null, { status: 404 });
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

  const { data: asset, error: assetError } = await admin
    .from("sponsor_assets")
    .select("id,camp_id,object_key")
    .eq("id", id)
    .maybeSingle();
  if (assetError || !asset) return NextResponse.json({ error: "Asset not found." }, { status: 404 });

  const { data: versions, error: versionsError } = await admin
    .from("prescription_template_versions")
    .select("template,status")
    .eq("camp_id", asset.camp_id)
    .in("status", ["draft", "published"]);
  if (versionsError) return NextResponse.json({ error: "Asset references could not be checked." }, { status: 500 });

  const assetUrl = `/api/admin/sponsor-assets/${id}`;
  const isReferenced = (versions ?? []).some((version) => {
    const template = version.template as
      | { sponsorLogos?: unknown; sponsorLogoUrl?: unknown }
      | null;
    const logos = template?.sponsorLogos;
    return (
      (Array.isArray(logos) && logos.includes(assetUrl)) ||
      template?.sponsorLogoUrl === assetUrl
    );
  });
  if (isReferenced) {
    return NextResponse.json(
      { error: "Remove this logo from every draft and published template first." },
      { status: 409 },
    );
  }

  const { error: storageError } = await admin.storage
    .from("prescription-sponsors")
    .remove([asset.object_key]);
  if (storageError) return NextResponse.json({ error: "Asset storage could not be removed." }, { status: 500 });

  const { error: deleteError } = await admin
    .from("sponsor_assets")
    .delete()
    .eq("id", id);
  if (deleteError) return NextResponse.json({ error: "Asset record could not be removed." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
