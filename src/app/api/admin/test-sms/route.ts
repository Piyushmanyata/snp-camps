import { NextResponse } from "next/server";
import { readJsonBody, requireAdmin } from "@/lib/auth";
import {
  fillRegistrationSms,
  isMsg91Configured,
  listSmsFailures,
  maxLengthRegistrationInputs,
  sendRegistrationSms,
  statusUrlForToken,
} from "@/lib/registration-sms";
import { normalizePhoneE164 } from "@/lib/phone";

/** Admin SMS status + recent failures (in-process log + host logs). */
export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const sample = fillRegistrationSms(maxLengthRegistrationInputs());

  return NextResponse.json({
    configured: isMsg91Configured(),
    failures: listSmsFailures(),
    sampleMaxLengthMessage: sample,
    sampleMaxLengthChars: sample.length,
  });
}

/**
 * Send the real registration DLT template to a number (admin pre-camp check).
 */
export async function POST(req: Request) {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const body = await readJsonBody<{ phone?: string }>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const phone = normalizePhoneE164(String(body.phone || ""));
  if (!phone) {
    return NextResponse.json(
      { error: "Enter a valid Indian mobile number" },
      { status: 400 },
    );
  }

  if (!isMsg91Configured()) {
    return NextResponse.json(
      {
        ok: false,
        status: "skipped",
        reason: "unconfigured",
        error:
          "MSG91 is not configured. Set MSG91_AUTH_KEY, MSG91_SENDER_ID, MSG91_TEMPLATE_REGISTRATION.",
      },
      { status: 400 },
    );
  }

  const result = await sendRegistrationSms(
    {
      phone,
      regNo: 999999,
      dayDate: "2026-09-30",
      venue: "Test venue SNP Camp",
      statusUrl: statusUrlForToken("test" + "0".repeat(28)),
    },
    { template: "test" },
  );

  if (result.status === "sent") {
    return NextResponse.json({
      ok: true,
      status: "sent",
      requestId: result.requestId,
      preview: fillRegistrationSms({
        regNo: 999999,
        dayDate: "2026-09-30",
        venue: "Test venue SNP Camp",
        statusUrl: statusUrlForToken("test" + "0".repeat(28)),
      }),
    });
  }

  if (result.status === "skipped") {
    return NextResponse.json({
      ok: false,
      status: "skipped",
      reason: result.reason,
    });
  }

  return NextResponse.json(
    { ok: false, status: "failed", detail: result.detail },
    { status: 502 },
  );
}
