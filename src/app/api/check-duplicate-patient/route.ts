import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/auth";
import { createServiceRoleClient } from "@/lib/supabase/admin";

type DuplicateCheckBody = {
  campId?: string;
  fullName?: string;
  phone?: string | null;
  age?: number | null;
  address?: string | null;
  aadhaarLast4?: string | null;
};

export type DuplicatePatientMatch = {
  id: string;
  reg_no: number;
  full_name: string;
  gender: string | null;
  age: number | null;
  address: string | null;
  phone: string | null;
  aadhaar_last4: string | null;
  queue_status: string;
  created_at: string;
  camp_day_id: string | null;
  day_date: string | null;
  match_reasons: string[];
};

export async function POST(request: Request) {
  const body = await readJsonBody<DuplicateCheckBody>(request);
  if (!body || !body.campId) {
    return NextResponse.json(
      { error: "Camp ID is required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const campId = String(body.campId).trim();
  const fullName = String(body.fullName || "").trim();
  const phone = String(body.phone || "").trim();
  const address = String(body.address || "").trim();
  const aadhaarLast4 = String(body.aadhaarLast4 || "").trim();
  const rawAge = body.age;
  const ageStr = String(rawAge ?? "").trim();
  const age =
    typeof rawAge === "number" && Number.isInteger(rawAge)
      ? rawAge
      : /^\d+$/.test(ageStr)
        ? Number(ageStr)
        : null;

  // Don't query if no meaningful search terms provided
  if (!phone && (!fullName || fullName.length < 2) && !aadhaarLast4) {
    return NextResponse.json({ duplicates: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Service unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const { data, error } = await admin.rpc("check_duplicate_patients", {
      p_camp_id: campId,
      p_full_name: fullName || null,
      p_phone: phone || null,
      p_age: age,
      p_address: address || null,
      p_aadhaar_last4: aadhaarLast4 || null,
    });

    if (error) {
      return NextResponse.json(
        { error: "Failed to check duplicate patients", details: error.message },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      { duplicates: (data as DuplicatePatientMatch[]) || [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: "Internal error", details: err instanceof Error ? err.message : "Unknown error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
