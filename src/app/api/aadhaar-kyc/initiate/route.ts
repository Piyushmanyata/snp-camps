import { NextResponse } from "next/server";
import {
  digitsOnly,
  isValidAadhaarNumber,
} from "@/lib/aadhaar";
import { getAadhaarKycProvider } from "@/lib/aadhaar-kyc";
import {
  createAadhaarKycSession,
  getAadhaarKycPepper,
} from "@/lib/aadhaar-kyc-session";
import { readJsonBody } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

const noStore = { "Cache-Control": "no-store" };
const initiateRate = {
  scope: "aadhaar-kyc-initiate",
  limit: 5,
  windowMs: 15 * 60_000,
} as const;

type Body = { aadhaar?: unknown };

function unavailable() {
  return NextResponse.json(
    {
      available: false,
      status: "unavailable",
      error: "Aadhaar eKYC is not available. Please use the camp desk.",
    },
    { status: 503, headers: noStore },
  );
}

function providerFailure(failureKind: "rejected" | "uncertain") {
  return NextResponse.json(
    {
      available: true,
      ok: false,
      failureKind,
      error:
        failureKind === "rejected"
          ? "Aadhaar verification could not be started. Check the number and try again."
          : "Aadhaar service could not be reached. Try again.",
    },
    { status: failureKind === "rejected" ? 400 : 502, headers: noStore },
  );
}

export async function POST(req: Request) {
  const rate = checkRateLimit(req, initiateRate);
  if (!rate.allowed) {
    return NextResponse.json(
      { available: true, ok: false, error: "Too many Aadhaar verification attempts. Try again later." },
      { status: 429, headers: { ...noStore, ...rate.headers } },
    );
  }

  const pepper = getAadhaarKycPepper();
  const provider = getAadhaarKycProvider();
  if (!pepper || !provider) return unavailable();

  const body = await readJsonBody<Body>(req);
  if (!body || typeof body.aadhaar !== "string") {
    return NextResponse.json(
      { available: true, ok: false, error: "Invalid JSON body." },
      { status: 400, headers: noStore },
    );
  }

  const aadhaar = digitsOnly(body.aadhaar);
  if (!isValidAadhaarNumber(aadhaar)) {
    return NextResponse.json(
      { available: true, ok: false, error: "Enter a valid 12-digit Aadhaar number." },
      { status: 400, headers: noStore },
    );
  }

  try {
    const result = await provider.initiateKyc(aadhaar);
    if (!result.ok) return providerFailure(result.failureKind);

    const session = createAadhaarKycSession({
      txnId: result.txnId,
      aadhaarDigits: aadhaar,
      pepper,
    });
    return NextResponse.json(
      {
        available: true,
        ok: true,
        handle: session.handle,
        expiresAt: session.expiresAt,
        maskedMobile: result.maskedMobile,
      },
      { headers: noStore },
    );
  } catch {
    return providerFailure("uncertain");
  }
}
