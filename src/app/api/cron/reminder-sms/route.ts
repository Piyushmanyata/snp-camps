import { NextResponse } from "next/server";
import {
  createReminderJobStore,
  runDayBeforeReminders,
} from "@/lib/reminder-sms";
import { createServiceRoleClient } from "@/lib/supabase/admin";

/**
 * Vercel Cron: day-before reminder SMS (#52).
 * Auth: Authorization: Bearer $CRON_SECRET (Vercel sets this when CRON_SECRET is configured).
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
    // Misconfig — do not throw; cron should not crash the platform.
    console.error("[reminder-sms] service role client unavailable");
    return NextResponse.json(
      { ok: false, error: "Service unavailable" },
      { status: 503 },
    );
  }

  try {
    const store = createReminderJobStore(supabase);
    const summary = await runDayBeforeReminders(store);
    return NextResponse.json(summary);
  } catch (err) {
    // Belt-and-braces: job is designed not to throw; still never 500 the camp.
    const detail = err instanceof Error ? err.message : "reminder job failed";
    console.error("[reminder-sms] unexpected", detail);
    return NextResponse.json(
      { ok: true, sent: 0, failed: 0, skipped: 0, error: detail },
      { status: 200 },
    );
  }
}
