import { NextResponse } from "next/server";
import { loadSessionProfile, readJsonBody } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { derivePersonDuplicateKey } from "@/lib/person-duplicate-key";
import { parseDateOfBirth, isNonLatinText } from "@/lib/aadhaar-text";
import { mapDbError } from "@/lib/public-error";
import { isStaff } from "@/lib/roles";

type Body = Record<string, unknown>;
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

function fail(message: string, status = 400) {
  return NextResponse.json({ data: null, error: { message } }, { status });
}

export async function POST(request: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId) return fail("Not signed in", 401);
  if (!isStaff(profile?.role)) return fail("Staff only", 403);

  const body = await readJsonBody<Body>(request, 16_384);
  if (!body) return fail("Invalid JSON body");

  const patientId = text(body.patientId);
  const mode = text(body.mode);
  if (!patientId || !["inspect", "commit", "override"].includes(mode)) {
    return fail("patientId and mode are required");
  }

  const supabase = await createClient();

  const fullName = text(body.fullName);
  const gender = text(body.gender).toUpperCase();
  const aadhaarLast4 = text(body.aadhaarLast4).replace(/\D/g, "").slice(-4);
  const address = text(body.address);
  const dob = parseDateOfBirth(text(body.dateOfBirth)) || text(body.dateOfBirth);
  const hasCard = Boolean(fullName && gender && aadhaarLast4.length === 4 && dob);

  let duplicateKey: string | null = null;
  if (hasCard && mode !== "override") {
    try {
      duplicateKey = derivePersonDuplicateKey({
        aadhaarLast4,
        name: fullName,
        dateOfBirth: dob,
        gender,
      });
    } catch {
      return fail("Card details are incomplete for confirmation.");
    }
  }

  const { data, error } = await supabase.rpc("confirm_manual_exception_aadhaar", {
    p_patient_id: patientId,
    p_mode: mode,
    p_duplicate_key: duplicateKey,
    p_full_name: fullName || null,
    p_date_of_birth: dob || null,
    p_gender: gender || null,
    p_aadhaar_last4: aadhaarLast4 || null,
    p_address: address || null,
    p_keep_display_name: isNonLatinText(fullName),
    p_actor_id: userId,
    p_override_reason: text(body.reason) || null,
  });

  if (error) {
    const message = error.message || "";
    if (message.includes("VOLUNTEER_OVERRIDE_FORBIDDEN")) {
      return fail("Team lead ya admin hi confirmation skip kar sakte hain.", 403);
    }
    if (/PERSON_ALREADY_REGISTERED:reg=(\d+)/.test(message)) {
      const reg = message.match(/PERSON_ALREADY_REGISTERED:reg=(\d+)/)?.[1];
      return fail(
        `Yeh card pehle se register hai (reg ${reg}). Usi number se print karein.`,
        409,
      );
    }
    return fail(
      mapDbError(error, {
        context: "aadhaar-confirm",
        fallback: "Confirm nahi hua. Dobara scan karein.",
      }),
      409,
    );
  }

  const row = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({ data: row, error: null });
}
