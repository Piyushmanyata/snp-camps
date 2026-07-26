import { NextResponse } from "next/server";
import { getAadhaarKycProvider } from "@/lib/aadhaar-kyc";
import {
  beginAadhaarKycVerification,
  finishAadhaarKycFailure,
  finishAadhaarKycVerification,
  getAadhaarKycPepper,
  peekVerifiedAadhaarKycSession,
  releaseAadhaarKycVerification,
} from "@/lib/aadhaar-kyc-session";
import { readJsonBody } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

const noStore = { "Cache-Control": "no-store" };
const verifyRate = {
  scope: "aadhaar-kyc-verify",
  limit: 5,
  windowMs: 15 * 60_000,
} as const;

type Body = { handle?: unknown; otp?: unknown };

function failure(
  failureKind: "rejected" | "uncertain" | "expired",
  status: number,
) {
  return NextResponse.json(
    {
      available: true,
      ok: false,
      failureKind,
      error:
        failureKind === "expired"
          ? "The Aadhaar OTP expired. Restart verification."
          : failureKind === "rejected"
            ? "The Aadhaar OTP was rejected. Restart verification."
            : "Aadhaar service could not confirm the OTP. Try again.",
    },
    { status, headers: noStore },
  );
}

export async function POST(req: Request) {
  const body = await readJsonBody<Body>(req);
  const handle = typeof body?.handle === "string" ? body.handle.trim() : "";
  const otp = typeof body?.otp === "string" ? body.otp : "";
  const rate = checkRateLimit(req, {
    ...verifyRate,
    identifier: handle || undefined,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { available: true, ok: false, error: "Too many Aadhaar OTP attempts. Try again later." },
      { status: 429, headers: { ...noStore, ...rate.headers } },
    );
  }

  const pepper = getAadhaarKycPepper();
  const provider = getAadhaarKycProvider();
  if (!pepper || !provider) {
    return NextResponse.json(
      {
        available: false,
        status: "unavailable",
        error: "Aadhaar eKYC is not available. Please use the camp desk.",
      },
      { status: 503, headers: noStore },
    );
  }

  if (!body || !handle || !/^\d{6}$/.test(otp)) {
    return NextResponse.json(
      { available: true, ok: false, error: "Enter the six-digit Aadhaar OTP." },
      { status: 400, headers: noStore },
    );
  }

  const session = beginAadhaarKycVerification(handle);
  if (session.status === "missing") {
    return failure("rejected", 404);
  }
  if (session.status === "expired") {
    return failure("expired", 410);
  }
  if (session.status === "rejected") {
    return failure("rejected", 400);
  }
  if (session.status === "verified") {
    return NextResponse.json(
      {
        available: true,
        ok: false,
        failureKind: "rejected",
        error: "This Aadhaar verification handle has already been used.",
      },
      { status: 409, headers: noStore },
    );
  }
  if (session.status === "verifying") {
    return failure("uncertain", 409);
  }

  try {
    const result = await provider.verifyOtp(session.txnId, otp);
    if (!result.ok) {
      finishAadhaarKycFailure(handle, result.failureKind);
      return failure(
        result.failureKind,
        result.failureKind === "expired"
          ? 410
          : result.failureKind === "rejected"
            ? 400
            : 502,
      );
    }

    if (
      !finishAadhaarKycVerification({
        handle,
        profile: result.profile,
        providerRef: result.providerRef,
        phone: result.phone,
      })
    ) {
      return failure("uncertain", 409);
    }

    const verified = peekVerifiedAadhaarKycSession(handle);
    return NextResponse.json(
      {
        available: true,
        ok: true,
        handle,
        profile: result.profile,
        phone: result.phone,
        aadhaarHash: verified?.aadhaarHash ?? null,
        aadhaarLast4: verified?.aadhaarLast4 ?? null,
        providerRef: result.providerRef,
      },
      { headers: noStore },
    );
  } catch {
    releaseAadhaarKycVerification(handle);
    return failure("uncertain", 502);
  }
}
