import { NextResponse } from "next/server";
import {
  digitsOnly,
  isValidAadhaarNumber,
} from "@/lib/aadhaar";
import { readJsonBody } from "@/lib/auth";

type Body = { aadhaar?: string };

/**
 * Aadhaar verification stub.
 * When AADHAAR_VERIFY_URL is set, POSTs to the provider.
 * Without a configured provider, verification fails closed; a checksum alone
 * is never treated as identity verification.
 * Never stores full Aadhaar.
 */
export async function POST(req: Request) {
  const body = await readJsonBody<Body>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const aadhaar = digitsOnly(String(body.aadhaar || ""));
  if (!isValidAadhaarNumber(aadhaar)) {
    return NextResponse.json(
      { verified: false, error: "Enter a valid 12-digit Aadhaar number." },
      { status: 400 },
    );
  }

  const providerUrl = process.env.AADHAAR_VERIFY_URL?.trim();
  const secret = process.env.AADHAAR_LOOKUP_SECRET?.trim()
    || process.env.AADHAAR_VERIFY_SECRET?.trim();

  // Never treat a checksum as identity verification; self-registration must
  // fail closed until an OTP/eKYC provider is configured.
  if (!providerUrl) {
    return NextResponse.json(
      {
        verified: false,
        mode: "unconfigured",
        error:
          "Aadhaar verification is not configured. Ask the desk to register you.",
      },
      { status: 503 },
    );
  }

  try {
    const res = await fetch(providerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ aadhaar, action: "verify" }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        {
          verified: false,
          mode: "provider",
          error:
            text.slice(0, 200) ||
            "Aadhaar verification failed. Try again or ask the desk.",
        },
        { status: 502 },
      );
    }

    const raw = (await res.json()) as {
      verified?: boolean;
      success?: boolean;
      error?: string;
    };

    const ok = raw.verified === true || raw.success === true;
    if (!ok) {
      return NextResponse.json(
        {
          verified: false,
          mode: "provider",
          error: raw.error || "Aadhaar could not be verified.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      verified: true,
      validated: true,
      mode: "provider",
      last4: aadhaar.slice(-4),
      message: "Aadhaar verified.",
    });
  } catch {
    return NextResponse.json(
      {
        verified: false,
        mode: "provider",
        error: "Aadhaar verification timed out. Try again.",
      },
      { status: 504 },
    );
  }
}
