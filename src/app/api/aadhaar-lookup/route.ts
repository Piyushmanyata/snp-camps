import { NextResponse } from "next/server";
import {
  ageFromDob,
  digitsOnly,
  isAadhaarLookupEnabledServer,
  isValidAadhaarNumber,
  normalizeGender,
  type AadhaarProfile,
} from "@/lib/aadhaar";
import { getSessionProfile, isStaff, readJsonBody } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";

type Body = { aadhaar?: string };

type ProviderPayload = {
  full_name?: string;
  name?: string;
  gender?: string;
  age?: number | string;
  dob?: string;
  date_of_birth?: string;
  address?: string;
  phone?: string;
  mobile?: string;
  email?: string;
};

/**
 * Fetch demographics from the configured Aadhaar / DigiLocker provider.
 * Enable with AADHAAR_LOOKUP_URL (+ optional AADHAAR_LOOKUP_SECRET).
 * Never persists the full Aadhaar number.
 */
export async function POST(req: Request) {
  const rate = checkRateLimit(req, {
    scope: "aadhaar-lookup",
    limit: 30,
    windowMs: 15 * 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many Aadhaar lookup attempts. Try again later." },
      { status: 429, headers: rate.headers },
    );
  }

  const { profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) {
    return NextResponse.json(
      { error: "Aadhaar lookup is available to camp staff only." },
      { status: 403 },
    );
  }
  if (!isAadhaarLookupEnabledServer()) {
    return NextResponse.json(
      {
        available: false,
        error:
          "Aadhaar auto-fill is not enabled. Enter details manually below.",
      },
      { status: 503 },
    );
  }

  const body = await readJsonBody<Body>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const aadhaar = digitsOnly(String(body.aadhaar || ""));
  if (!isValidAadhaarNumber(aadhaar)) {
    return NextResponse.json(
      { error: "Enter a valid 12-digit Aadhaar number." },
      { status: 400 },
    );
  }

  const url = process.env.AADHAAR_LOOKUP_URL!.trim();
  const secret = process.env.AADHAAR_LOOKUP_SECRET?.trim();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ aadhaar }),
      // Camp desk should fail fast if provider is down
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      await res.text().catch(() => "");
      return NextResponse.json(
        {
          available: true,
          error:
            "Aadhaar lookup failed. Fill the form manually.",
        },
        { status: 502 },
      );
    }

    const raw = (await res.json()) as ProviderPayload;
    const ageRaw =
      raw.age != null && raw.age !== ""
        ? Number(raw.age)
        : ageFromDob(raw.dob || raw.date_of_birth);

    const aadhaarProfile: AadhaarProfile = {
      full_name: (raw.full_name || raw.name || "").trim() || null,
      gender: normalizeGender(raw.gender),
      age:
        ageRaw != null && Number.isFinite(ageRaw) && ageRaw >= 0 && ageRaw < 150
          ? Math.floor(ageRaw)
          : null,
      address: (raw.address || "").trim() || null,
      phone: digitsOnly(raw.phone || raw.mobile || "").slice(-10) || null,
      email: (raw.email || "").trim() || null,
    };

    if (!aadhaarProfile.full_name && !aadhaarProfile.address && !aadhaarProfile.phone) {
      return NextResponse.json(
        {
          available: true,
          error: "No details returned for this Aadhaar. Enter manually.",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      available: true,
      profile: aadhaarProfile,
      // Client may store last 4 only after success
      last4: aadhaar.slice(-4),
    });
  } catch {
    return NextResponse.json(
      {
        available: true,
        error:
          "Aadhaar service timed out or is unreachable. Enter details manually.",
      },
      { status: 504 },
    );
  }
}
