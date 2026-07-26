import { NextResponse } from "next/server";
import {
  createReminderJobStore,
  runDayBeforeReminders,
} from "@/lib/reminder-sms";
import { createServiceRoleClient } from "@/lib/supabase/admin";

/**
 * Vercel Cron: day-before reminder SMS (#52 + #65).
 * Auth: Authorization: Bearer $CRON_SECRET
 * Job-level failures (list/schema/config) return non-2xx + ok:false.
 * Per-patient failures still return 200 with truthful counts.
 */
export async function GET(request: Request) {
  return handleCron(request);
}

export async function POST(request: Request) {
  return handleCron(request);
}

function authorizeCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization")?.trim() ?? "";
  return header === `Bearer ${secret}`;
}

async function handleCron(request: Request) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  if (!supabase) {
    console.error("[reminder-sms] service role client unavailable");
    return NextResponse.json(
      { ok: false, error: "Service unavailable" },
      { status: 503 },
    );
  }

  try {
    const store = createReminderJobStore(supabase);
    const summary = await runDayBeforeReminders(store);
    if (!summary.ok) {
      return NextResponse.json(summary, { status: 500 });
    }
    return NextResponse.json(summary);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "reminder job failed";
    console.error("[reminder-sms] unexpected", detail.slice(0, 300));
    return NextResponse.json(
      {
        ok: false,
        sent: 0,
        failed: 0,
        skipped: 0,
        ambiguous: 0,
        error: detail.slice(0, 300),
      },
      { status: 500 },
    );
  }
}
