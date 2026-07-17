import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import type { CampDayStats } from "@/lib/types";
import { SeatBoard } from "@/components/seat-board";

export default async function HomePage() {
  const { profile } = await getSessionProfile();
  if (profile?.role === "admin") redirect("/admin");
  if (profile?.role === "volunteer") redirect("/volunteer");
  if (profile?.role === "patient") redirect("/patient");

  const supabase = await createClient();
  const { data: camp } = await supabase
    .from("camps")
    .select("id, name, venue")
    .eq("is_active", true)
    .maybeSingle();

  const { data: dayStats } = camp
    ? await supabase.rpc("camp_day_stats", { p_camp_id: camp.id })
    : { data: [] };

  const days = (dayStats as CampDayStats[]) || [];
  const anyOpen = days.some((d) => !d.is_full);

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="space-y-3 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-xl font-bold text-white shadow-md">
          SNP
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand">
            Sikar Nagarik Parishad · Kolkata
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-[2rem]">
            Medical Camp Desk
          </h1>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">
            Multi-day eye camp · limited seats per day · register, get QR, check
            in at the desk
          </p>
        </div>
      </div>

      {camp ? (
        <div className="space-y-2">
          <p className="text-center text-sm font-medium text-foreground">
            {camp.name}
            {camp.venue ? (
              <span className="font-normal text-muted"> · {camp.venue}</span>
            ) : null}
          </p>
          <SeatBoard days={days} title="Seats by day" compact />
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-sm text-muted">
          No active camp right now. Check back later.
        </p>
      )}

      <div className="grid gap-3">
        <Link
          href="/register"
          className={`group flex min-h-[4.25rem] flex-col items-center justify-center rounded-2xl px-4 py-3 shadow-md transition active:scale-[0.99] ${
            camp && anyOpen
              ? "bg-brand text-white hover:bg-brand-dark"
              : "pointer-events-none bg-gray-200 text-gray-500"
          }`}
          aria-disabled={!camp || !anyOpen}
        >
          <span className="text-lg font-bold">Patient registration</span>
          <span
            className={`text-xs font-medium ${
              camp && anyOpen ? "text-white/80" : "text-gray-500"
            }`}
          >
            {!camp
              ? "No active camp"
              : anyOpen
                ? "Pick a day → reg no + QR"
                : "All days full"}
          </span>
        </Link>

        <Link
          href="/patient/login"
          className="flex min-h-14 flex-col items-center justify-center rounded-2xl border border-border bg-card px-4 py-3 shadow-sm transition hover:border-brand/30 hover:bg-brand-soft"
        >
          <span className="text-base font-semibold">Patient login</span>
          <span className="text-xs text-muted">
            Phone OTP · view QR · change day
          </span>
        </Link>

        <Link
          href="/login"
          className="flex min-h-14 flex-col items-center justify-center rounded-2xl border border-brand/20 bg-brand-soft px-4 py-3 transition hover:bg-white"
        >
          <span className="text-base font-semibold text-brand">Staff login</span>
          <span className="text-xs text-brand/70">Admin &amp; volunteers</span>
        </Link>
      </div>

      <p className="text-center text-xs text-muted">
        First-time staff?{" "}
        <Link href="/staff/register" className="font-medium text-brand underline">
          Setup with invite code
        </Link>
      </p>

      {isStaff(profile?.role) ? (
        <p className="text-center text-sm text-muted">Signed in as staff.</p>
      ) : null}
    </main>
  );
}
