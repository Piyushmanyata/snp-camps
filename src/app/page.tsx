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
  if (profile?.role === "doctor") redirect("/doctor");
  if (profile?.role === "patient") redirect("/patient");

  const supabase = await createClient();
  const { data: camp } = await supabase
    .from("camps")
    .select("id, name, venue")
    .eq("is_active", true)
    .maybeSingle();

  const { data: dayStats } = camp
    ? await supabase.rpc("camp_day_stats", { p_camp_id: camp.id })
    : { data: [] as CampDayStats[] };

  const days = (dayStats as CampDayStats[]) || [];
  const anyOpen = days.some((d) => !d.is_full);

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-4 py-10 sm:max-w-3xl sm:px-6 lg:max-w-5xl lg:px-8 lg:py-14">
      <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
        <div className="space-y-3 text-center lg:text-left">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-xl font-bold text-white shadow-md lg:mx-0">
            SNP
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand">
              Sikar Nagarik Parishad · Kolkata
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">
              Medical Camp Desk
            </h1>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted lg:mx-0">
              Multi-day eye camp · limited seats per day · register, print at
              desk, then doctor scan
            </p>
          </div>

          {camp ? (
            <p className="text-sm font-medium text-foreground">
              {camp.name}
              {camp.venue ? (
                <span className="font-normal text-muted"> · {camp.venue}</span>
              ) : null}
            </p>
          ) : (
            <p className="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted">
              No active camp right now. Check back later.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <Link
              href="/register"
              className={`group flex min-h-[4.25rem] flex-col items-center justify-center rounded-2xl px-4 py-3 shadow-md transition active:scale-[0.99] sm:col-span-3 lg:col-span-1 ${
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
                    ? "Pick a day → reg no + show QR at desk"
                    : "All days full"}
              </span>
            </Link>

            <Link
              href="/patient/login"
              className="flex min-h-14 flex-col items-center justify-center rounded-2xl border border-border bg-card px-4 py-3 shadow-sm transition hover:border-brand/30 hover:bg-brand-soft sm:col-span-1"
            >
              <span className="text-base font-semibold">Patient login</span>
              <span className="text-xs text-muted">
                View reg no &amp; status
              </span>
            </Link>

            <Link
              href="/login"
              className="flex min-h-14 flex-col items-center justify-center rounded-2xl border border-brand/20 bg-brand-soft px-4 py-3 transition hover:bg-white sm:col-span-1"
            >
              <span className="text-base font-semibold text-brand">
                Staff login
              </span>
              <span className="text-xs text-brand/70">
                Admin · volunteers · doctors
              </span>
            </Link>

            <p className="text-center text-xs text-muted sm:col-span-1 lg:text-left">
              First-time staff?{" "}
              <Link
                href="/staff/register"
                className="font-medium text-brand underline"
              >
                Setup with invite code
              </Link>
            </p>
          </div>

          {isStaff(profile?.role) ? (
            <p className="text-sm text-muted">Signed in as staff.</p>
          ) : null}
        </div>

        <div className="min-w-0">
          {camp ? (
            <SeatBoard days={days} title="Seats by day" compact />
          ) : (
            <div className="hidden rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted lg:block">
              Seat board appears when a camp is active.
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
