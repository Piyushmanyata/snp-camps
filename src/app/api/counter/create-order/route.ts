import { NextResponse } from "next/server";
import {
  isCampCrew,
  loadSessionProfile,
  readJsonBody,
} from "@/lib/auth";
import { isPatientUuid } from "@/lib/qr";
import { mapDbError } from "@/lib/public-error";
import { createClient } from "@/lib/supabase/server";

const TREATMENT_KINDS = new Set(["ot", "pharmacy", "spectacles"]);

export async function POST(request: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId || !isCampCrew(profile?.role)) {
    return NextResponse.json(
      { ok: false, error: "Camp crew access required" },
      { status: 403 },
    );
  }

  const body = await readJsonBody<{
    patientId?: unknown;
    kinds?: unknown;
  }>(request, 2_048);
  const patientId =
    typeof body?.patientId === "string" ? body.patientId.trim() : "";
  const kinds = Array.isArray(body?.kinds)
    ? [
        ...new Set(
          body.kinds
            .filter((kind): kind is string => typeof kind === "string")
            .map((kind) => kind.trim().toLowerCase()),
        ),
      ]
    : [];

  if (
    !isPatientUuid(patientId) ||
    kinds.length === 0 ||
    kinds.length > 3 ||
    kinds.some((kind) => !TREATMENT_KINDS.has(kind))
  ) {
    return NextResponse.json(
      { ok: false, error: "Valid patient and treatment kinds are required" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "counter_create_and_fulfill_order",
    {
      p_patient_id: patientId,
      p_kinds: kinds,
    },
  );

  if (error) {
    return NextResponse.json(
      {
        ok: false,
        error: mapDbError(error, {
          context: "counter.create-order",
          fallback: "Could not create treatment order.",
        }),
      },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true, data });
}
