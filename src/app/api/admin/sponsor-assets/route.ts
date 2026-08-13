import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { loadSessionProfile } from "@/lib/auth";
import { isPatientUuid } from "@/lib/qr";
import { createServiceRoleClient } from "@/lib/supabase/admin";

const MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function GET(request: Request) {
  const { profile } = await loadSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  const admin = createServiceRoleClient();
  if (!admin) return NextResponse.json({ error: "Asset service unavailable" }, { status: 503 });
  const campId = new URL(request.url).searchParams.get("campId")?.trim() ?? "";
  if (campId && !isPatientUuid(campId)) {
    return NextResponse.json({ error: "Invalid camp" }, { status: 400 });
  }
  let query = admin
    .from("sponsor_assets")
    .select("id,camp_id,mime_type,byte_size,created_at,state,state_changed_at,cleanup_attempts,last_error_code")
    .order("created_at", { ascending: false });
  if (campId) query = query.eq("camp_id", campId);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Assets could not be loaded." }, { status: 502 });
  return NextResponse.json({
    assets: (data ?? []).map((asset) => ({
      ...asset,
      url: `/api/admin/sponsor-assets/${asset.id}`,
    })),
  });
}

function hasExpectedMagic(bytes: Uint8Array, mime: string) {
  if (mime === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  );
}

export async function POST(request: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const form = await request.formData();
  const campId = String(form.get("campId") ?? "");
  if (!isPatientUuid(campId)) {
    return NextResponse.json(
      { error: "Select a camp before uploading." },
      { status: 400 },
    );
  }
  const file = form.get("file");
  if (!(file instanceof File) || !MIME.has(file.type) || file.size < 1 || file.size > 2_097_152) {
    return NextResponse.json({ error: "Upload PNG, JPEG, or WebP up to 2 MB." }, { status: 400 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasExpectedMagic(bytes, file.type)) {
    return NextResponse.json({ error: "Image content does not match its file type." }, { status: 400 });
  }
  const admin = createServiceRoleClient();
  if (!admin) return NextResponse.json({ error: "Asset service unavailable" }, { status: 503 });
  const { data: campRow } = await admin
    .from("camps")
    .select("id")
    .eq("id", campId)
    .maybeSingle();
  if (!campRow) {
    return NextResponse.json(
      { error: "Select a camp before uploading." },
      { status: 400 },
    );
  }
  const extension = file.type === "image/png" ? "png" : file.type === "image/jpeg" ? "jpg" : "webp";
  const id = randomUUID();
  const objectKey = `${campId}/${id}.${extension}`;
  const { error: pendingError } = await admin.from("sponsor_assets").insert({
    id,
    camp_id: campId,
    object_key: objectKey,
    mime_type: file.type,
    byte_size: file.size,
    created_by: userId,
    state: "pending",
  });
  if (pendingError) {
    return NextResponse.json({ error: "Asset record failed." }, { status: 500 });
  }
  const { error: uploadError } = await admin.storage
    .from("prescription-sponsors")
    .upload(objectKey, bytes, { contentType: file.type, upsert: false });
  if (uploadError) {
    const { error: cleanupError } = await admin
      .from("sponsor_assets")
      .delete()
      .eq("id", id)
      .eq("state", "pending");
    if (cleanupError) {
      await admin
        .from("sponsor_assets")
        .update({ last_error_code: "UPLOAD_OR_CLEANUP_FAILED" })
        .eq("id", id)
        .eq("state", "pending");
    }
    return NextResponse.json({ error: "Asset upload failed." }, { status: 502 });
  }
  const { error: readyError } = await admin
    .from("sponsor_assets")
    .update({ state: "ready", state_changed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("state", "pending");
  if (readyError) {
    await admin
      .from("sponsor_assets")
      .update({ last_error_code: "UPLOAD_OR_CLEANUP_FAILED" })
      .eq("id", id)
      .eq("state", "pending");
    return NextResponse.json({ error: "Asset is awaiting cleanup." }, { status: 502 });
  }
  return NextResponse.json({ id, state: "ready", url: `/api/admin/sponsor-assets/${id}` });
}
