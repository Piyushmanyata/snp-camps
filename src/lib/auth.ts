import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import type { Profile, UserRole } from "@/lib/types";
import { cache } from "react";

export const getSessionProfile = cache(async (): Promise<{
  userId: string | null;
  profile: Profile | null;
}> => {
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { userId: null, profile: null };

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, full_name, phone, email")
    .eq("id", user.id)
    .maybeSingle();

  return { userId: user.id, profile: profile as Profile | null };
});

export function isStaff(role?: UserRole | null) {
  return role === "admin" || role === "volunteer" || role === "doctor";
}

export function isAdmin(role?: UserRole | null) {
  return role === "admin";
}

export function isDoctor(role?: UserRole | null) {
  return role === "doctor";
}

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

/** Parse a small JSON body — rejects if Content-Length exceeds maxBytes. */
export async function readJsonBody<T = Record<string, unknown>>(
  req: Request,
  maxBytes = 16_384,
): Promise<T | null> {
  try {
    const cl = req.headers.get("content-length");
    if (cl && Number(cl) > maxBytes) return null;
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
