import { NextResponse } from "next/server";
import { loadSessionProfile } from "@/lib/auth";
import { isStaff } from "@/lib/roles";
import { derivePersonDuplicateKey } from "@/lib/person-duplicate-key";

/**
 * Mint the Person duplicate key for a scanned Aadhaar card (#111).
 *
 * The desk form runs in the browser and calls `register_patient_idempotent`
 * directly, but the key is `HMAC(last4 + normalised name + DOB + gender)` under
 * the Aadhaar pepper — a server secret that must never be shipped to a client.
 * So the form posts the four scanned identity fields here and gets the key back.
 *
 * Staff only: the key is a stable identifier for a real person, so minting it is
 * not something an anonymous caller gets to do.
 */
export async function POST(request: Request) {
  const { profile } = await loadSessionProfile();
  if (!isStaff(profile?.role)) {
    return NextResponse.json({ ok: false, error: "Not allowed" }, { status: 403 });
  }

  let body: {
    name?: unknown;
    aadhaarLast4?: unknown;
    dateOfBirth?: unknown;
    gender?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name = str(body.name);
  const aadhaarLast4 = str(body.aadhaarLast4);
  const dateOfBirth = str(body.dateOfBirth);
  const gender = str(body.gender);

  if (!name || !aadhaarLast4 || !dateOfBirth || !gender) {
    return NextResponse.json(
      { ok: false, error: "Scanned name, Aadhaar last-4, date of birth and gender are all required." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({
      ok: true,
      key: derivePersonDuplicateKey({ name, aadhaarLast4, dateOfBirth, gender }),
    });
  } catch (err) {
    // A missing pepper is a misconfiguration, not a bad request — but the
    // message names an env var, so it stays out of the response body.
    console.error("[person-key] derive failed", err);
    return NextResponse.json(
      { ok: false, error: "Card identity could not be prepared. Register manually." },
      { status: 500 },
    );
  }
}
