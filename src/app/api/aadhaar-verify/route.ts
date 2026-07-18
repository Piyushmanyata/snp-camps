import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import {
  digitsOnly,
  isValidAadhaarNumber,
} from "@/lib/aadhaar";
import { readJsonBody } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { createServiceRoleClient } from "@/lib/supabase/admin";

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
    return NextResponse.json(
      { error: "Invalid or oversized JSON body" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const aadhaar = digitsOnly(String(body.aadhaar || ""));
  if (!isValidAadhaarNumber(aadhaar)) {
    return NextResponse.json(
      { verified: false, error: "Enter a valid 12-digit Aadhaar number." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const rate = checkRateLimit(req, {
    scope: "aadhaar-verify",
    identifier: aadhaar,
    limit: 6,
    windowMs: 10 * 60_000,
  });
  const responseHeaders = {
    ...rate.headers,
    "Cache-Control": "no-store, max-age=0",
  };
  if (!rate.allowed) {
    return NextResponse.json(
      { verified: false, error: "Too many verification attempts. Try again later." },
      { status: 429, headers: responseHeaders },
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
      { status: 503, headers: responseHeaders },
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
      return NextResponse.json(
        {
          verified: false,
          mode: "provider",
          error: "Aadhaar verification failed. Try again or ask the desk.",
        },
        { status: 502, headers: responseHeaders },
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
          error: "Aadhaar could not be verified. Check the details and try again.",
        },
        { status: 400, headers: responseHeaders },
      );
    }

    const admin = createServiceRoleClient();
    if (!admin) {
      return NextResponse.json(
        { verified: false, error: "Registration service is unavailable." },
        { status: 503, headers: responseHeaders },
      );
    }

    const verificationToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256")
      .update(verificationToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const { error: claimError } = await admin
      .from("registration_verifications")
      .insert({
        token_hash: tokenHash,
        aadhaar_last4: aadhaar.slice(-4),
        expires_at: expiresAt,
      });

    if (claimError) {
      return NextResponse.json(
        { verified: false, error: "Registration service is unavailable." },
        { status: 503, headers: responseHeaders },
      );
    }

    if (Math.random() < 0.02) {
      await admin
        .from("registration_verifications")
        .delete()
        .lt("expires_at", new Date().toISOString());
    }

    return NextResponse.json(
      {
        verified: true,
        validated: true,
        mode: "provider",
        last4: aadhaar.slice(-4),
        verificationToken,
        expiresAt,
        message: "Aadhaar verified.",
      },
      { headers: responseHeaders },
    );
  } catch {
    return NextResponse.json(
      {
        verified: false,
        mode: "provider",
        error: "Aadhaar verification timed out. Try again.",
      },
      { status: 504, headers: responseHeaders },
    );
  }
}
