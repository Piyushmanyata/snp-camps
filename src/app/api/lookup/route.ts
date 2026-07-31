import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/auth";
import { checkDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { checkRateLimit } from "@/lib/rate-limit";
import { createServiceRoleClient } from "@/lib/supabase/admin";

const LOOKUP_RATE_LIMIT = {
  scope: "patient-lookup",
  limit: 5,
  windowMs: 60_000,
};

export async function POST(request: Request) {
  const rate = checkRateLimit(request, LOOKUP_RATE_LIMIT);
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, error: "Ye registration number aur janm tithi match nahi hui." },
      { status: 429, headers: rate.headers },
    );
  }

  const body = await readJsonBody<{
    regNo?: unknown;
    dateOfBirth?: unknown;
  }>(request, 1_024);
  if (!body) {
    return NextResponse.json(
      { ok: false, error: "Ye registration number aur janm tithi match nahi hui." },
      { status: 400 },
    );
  }

  const regNo = Number(body.regNo);
  const dobStr = String(body.dateOfBirth || "").trim();

  if (!Number.isInteger(regNo) || regNo <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(dobStr)) {
    return NextResponse.json(
      { ok: false, error: "Ye registration number aur janm tithi match nahi hui." },
      { status: 400 },
    );
  }

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "Ye registration number aur janm tithi match nahi hui." },
      { status: 500 },
    );
  }

  const durableRate = await checkDistributedRateLimit(request, admin, {
    ...LOOKUP_RATE_LIMIT,
    identifier: String(regNo),
  });
  if (!durableRate.allowed) {
    return NextResponse.json(
      { ok: false, error: "Ye registration number aur janm tithi match nahi hui." },
      {
        status: durableRate.unavailable ? 503 : 429,
        headers: {
          "Retry-After": String(durableRate.retryAfterSeconds),
        },
      },
    );
  }

  const { data, error } = await admin.rpc("lookup_patient_status_token", {
    p_reg_no: regNo,
    p_date_of_birth: dobStr,
  });

  if (error || !Array.isArray(data) || data.length === 0 || !data[0]?.status_token) {
    return NextResponse.json(
      { ok: false, error: "Ye registration number aur janm tithi match nahi hui." },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    redirectUrl: `/s/${data[0].status_token}`,
  });
}
