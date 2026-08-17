import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  createReminderJobStore,
  runDayBeforeReminders,
} from "@/lib/reminder-sms";
import { runDayBeforeDeferralSms } from "@/lib/deferral-sms";
import { createServiceRoleClient } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  return handleCron(request);
}

export async function POST(request: Request) {
  return handleCron(request);
}

export function authorizeCron(request: Request, env = process.env): boolean {
  const secret = env.CRON_SECRET?.trim();
  if (!secret) {
    console.error("[reminder-sms] cron called while CRON_SECRET is unconfigured");
    return false;
  }
  const header = request.headers.get("authorization")?.trim() ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const supplied = header.slice(prefix.length);
  const expected = Buffer.from(secret, "utf8");
  const actual = Buffer.from(supplied, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
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
    const deferral = await runDayBeforeDeferralSms(supabase);
    if (!summary.ok || !deferral.ok) {
      return NextResponse.json(
        { ...summary, deferral },
        { status: 500 },
      );
    }
    return NextResponse.json({ ...summary, deferral });
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
