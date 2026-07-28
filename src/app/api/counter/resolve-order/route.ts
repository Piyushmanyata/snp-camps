import { NextResponse } from "next/server";
import { loadSessionProfile, isCampCrew, readJsonBody } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { mapDbError } from "@/lib/public-error";
import { isPatientUuid } from "@/lib/qr";

export async function POST(req: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId || !isCampCrew(profile?.role)) {
    return NextResponse.json({ error: "Camp crew access required" }, { status: 403 });
  }

  const body = await readJsonBody<{
    orderId?: string;
    action?: string;
    deferredDate?: string | null;
    deferredVenue?: string | null;
  }>(req);

  if (
    !body?.orderId ||
    typeof body.orderId !== "string" ||
    !isPatientUuid(body.orderId.trim())
  ) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }

  const action = (body.action || "").trim().toLowerCase();
  if (!["fulfilled", "deferred", "cancelled"].includes(action)) {
    return NextResponse.json(
      { error: "action must be fulfilled, deferred, or cancelled" },
      { status: 400 }
    );
  }

  if (action === "deferred" && !body.deferredDate) {
    return NextResponse.json(
      { error: "deferredDate is required when deferring an order" },
      { status: 400 }
    );
  }

  if (
    body.deferredDate &&
    !/^\d{4}-\d{2}-\d{2}$/.test(body.deferredDate)
  ) {
    return NextResponse.json(
      { error: "deferredDate must use YYYY-MM-DD" },
      { status: 400 },
    );
  }

  if (
    body.deferredVenue != null &&
    (typeof body.deferredVenue !== "string" ||
      body.deferredVenue.trim().length > 160)
  ) {
    return NextResponse.json(
      { error: "deferredVenue must be at most 160 characters" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("resolve_treatment_order", {
    p_order_id: body.orderId.trim(),
    p_action: action,
    p_deferred_date: body.deferredDate || null,
    p_deferred_venue: body.deferredVenue?.trim() || null,
  });

  if (error) {
    const userMsg = mapDbError(error, {
      context: "counter.resolve-order",
      fallback: "Could not resolve treatment order.",
    });
    return NextResponse.json({ error: userMsg }, { status: 400 });
  }

  const updatedOrder = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({ ok: true, order: updatedOrder });
}
