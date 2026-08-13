import { NextResponse } from "next/server";
import { loadSessionProfile } from "@/lib/auth";
import { isPatientUuid } from "@/lib/qr";
import {
  buildCampRecordsCsv,
  buildClinicalAuditCsv,
  exportFilename,
  type ExportAuditRow,
  type ExportRecordRow,
} from "@/lib/clinical-export";
import { createServiceRoleClient } from "@/lib/supabase/admin";

type ExportPayload = {
  camp_id: string;
  camp_name: string;
  diagnosis_options?: string[];
  retired_diagnosis_options?: string[];
  rows: ExportRecordRow[] | ExportAuditRow[];
};

export async function GET(request: Request) {
  const { profile } = await loadSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (profile.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") ?? "records").trim();
  if (format !== "records" && format !== "audit") {
    return NextResponse.json(
      { error: "Choose format=records or format=audit." },
      { status: 400 },
    );
  }
  const campIdRaw = url.searchParams.get("campId")?.trim() ?? "";
  if (campIdRaw && !isPatientUuid(campIdRaw)) {
    return NextResponse.json({ error: "Invalid camp" }, { status: 400 });
  }
  const includeArchived =
    url.searchParams.get("includeArchived") === "1" ||
    url.searchParams.get("includeArchived") === "true";

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json({ error: "Export service unavailable" }, { status: 503 });
  }

  const { data, error } = await admin.rpc("admin_clinical_export", {
    p_camp_id: campIdRaw || null,
    p_format: format,
    p_include_archived: includeArchived,
  });

  if (error) {
    const message = error.message ?? "";
    if (/no camp selected/i.test(message) || /no active camp/i.test(message)) {
      return NextResponse.json(
        { error: "Select a camp, or activate a camp, before exporting." },
        { status: 400 },
      );
    }
    if (/admin only/i.test(message)) {
      return NextResponse.json({ error: "Admin only" }, { status: 403 });
    }
    return NextResponse.json(
      { error: "Export failed. Try again." },
      { status: 502 },
    );
  }

  const payload = data as ExportPayload | null;
  if (!payload?.camp_name) {
    return NextResponse.json(
      { error: "Select a camp, or activate a camp, before exporting." },
      { status: 400 },
    );
  }

  const csv =
    format === "records"
      ? buildCampRecordsCsv(
          payload.camp_name,
          payload.diagnosis_options ?? [],
          (payload.rows ?? []) as ExportRecordRow[],
          payload.retired_diagnosis_options ?? [],
        )
      : buildClinicalAuditCsv(
          payload.camp_name,
          (payload.rows ?? []) as ExportAuditRow[],
        );

  const filename = exportFilename(
    format === "records" ? "records" : "audit",
    payload.camp_name,
  );

  return new NextResponse(new TextEncoder().encode(csv), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
