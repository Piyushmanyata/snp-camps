import { NextResponse } from "next/server";
import { loadSessionProfile } from "@/lib/auth";
import { isStaff } from "@/lib/roles";
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
