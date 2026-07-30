import { NextResponse } from "next/server";
import { canRegisterPatients, getSessionProfile } from "@/lib/auth";
import { isPatientUuid } from "@/lib/qr";
import { createClient } from "@/lib/supabase/server";
import type { QueueStatus } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

interface PrintResult {
  already_printed: boolean;
  queue_status: QueueStatus;
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return json({ error: "JSON request required" }, 415);
  }

  const { userId, profile } = await getSessionProfile();
  if (!userId) return json({ error: "Not signed in" }, 401);
  if (!canRegisterPatients(profile?.role)) {
    return json({ error: "Admin or volunteer access required" }, 403);
  }

  const { id } = await params;
  if (!isPatientUuid(id)) return json({ error: "Invalid patient ID" }, 400);

  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("mark_patient_printed", { p_id: id })
    .maybeSingle();

  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes("not found")) {
      return json({ error: "Patient not found" }, 404);
    }
    if (message.includes("inactive camp")) {
      return json({ error: "This patient's camp is no longer active" }, 409);
    }
    return json({ error: "Could not add the patient to the queue" }, 409);
  }
  const result = data as PrintResult | null;
  if (!result) return json({ error: "Patient queue state was not returned" }, 500);

  return json({
    ok: true,
    alreadyPrinted: Boolean(result.already_printed),
    queueStatus: result.queue_status,
  });
}
