import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";
import { cache } from "react";

export {
  isStaff,
  isCampCrew,
  isAdmin,
  isTeamLead,
  canRegisterPatients,
  roleHome,
} from "@/lib/roles";

/**
 * Uncached session load for API route handlers (and tests).
 * Prefer this in route handlers so role checks are not stuck on a
 * request-scoped React cache entry from an earlier call in the same process.
 */
export async function loadSessionProfile(): Promise<{
  userId: string | null;
  profile: Profile | null;
}> {
  const cookieStore = await cookies();
  const hasSessionCookie = cookieStore
    .getAll()
    .some(
      (cookie) =>
        cookie.name.includes("auth-token") ||
        (cookie.name.startsWith("sb-") && cookie.name.includes("auth")),
    );
  if (!hasSessionCookie) return { userId: null, profile: null };

  const supabase = await createClient();
  const { data: claimData, error: claimError } = await supabase.auth.getClaims();
  const userId =
    !claimError && typeof claimData?.claims?.sub === "string"
      ? claimData.claims.sub
      : null;
  if (!userId) return { userId: null, profile: null };

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, full_name, phone, email, disabled_at")
    .eq("id", userId)
    .maybeSingle();

  if (!profile || (profile as Profile).disabled_at) {
    return { userId: null, profile: null };
  }

  return { userId, profile: profile as Profile };
}

/** Request-deduped session for Server Components / layouts. */
export const getSessionProfile = cache(loadSessionProfile);

/** API guard: requires signed-in admin. Returns JSON error response or user+profile. */
export async function requireAdmin() {
  const { userId, profile } = await getSessionProfile();
  if (!userId) {
    return {
      error: NextResponse.json({ error: "Not signed in" }, { status: 401 }),
    };
  }
  if (profile?.role !== "admin") {
    return {
      error: NextResponse.json({ error: "Admin only" }, { status: 403 }),
    };
  }
  return { userId, profile };
}

/** Parse a small JSON body with a strict media type and bounded decoded size. */
export async function readJsonBody<T = Record<string, unknown>>(
  req: Request,
  maxBytes = 16_384,
): Promise<T | null> {
  try {
    const mediaType = req.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (mediaType !== "application/json") return null;

    const cl = req.headers.get("content-length");
    if (cl && Number(cl) > maxBytes) return null;
    if (!req.body) return null;

    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}
