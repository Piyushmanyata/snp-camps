import { NextResponse } from "next/server";

/** Retired unverified lookup endpoint (#86); verified eKYC is the only provider path. */
export async function POST() {
  return NextResponse.json(
    { available: false, error: "Unverified Aadhaar lookup has been retired. Use verified eKYC or the desk." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
