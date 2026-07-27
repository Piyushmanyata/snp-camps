import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  let body: { patientId?: unknown; kinds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const patientId = typeof body.patientId === "string" ? body.patientId.trim() : "";
  const kinds = Array.isArray(body.kinds) ? body.kinds.filter((k) => typeof k === "string") : [];

  if (!patientId || kinds.length === 0) {
    return NextResponse.json({ ok: false, error: "patientId and at least one treatment kind required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("counter_create_and_fulfill_order", {
    p_patient_id: patientId,
    p_kinds: kinds,
  });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, data });
}
