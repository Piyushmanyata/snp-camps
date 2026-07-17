import Link from "next/link";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function HomePage() {
  const { profile } = await getSessionProfile();
  if (profile?.role === "admin") redirect("/admin");
  if (profile?.role === "volunteer") redirect("/volunteer");
  if (profile?.role === "patient") redirect("/patient");

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="space-y-2 text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand">
          Sikar Nagarik Parishad
        </p>
        <h1 className="text-3xl font-bold tracking-tight">Medical Camp Desk</h1>
        <p className="text-muted">
          Register, get your ID & QR, join the queue. Keep it simple.
        </p>
      </div>

      <div className="grid gap-3">
        <Link
          href="/register"
          className="flex min-h-14 items-center justify-center rounded-2xl bg-brand text-lg font-semibold text-white"
        >
          Patient registration
        </Link>
        <Link
          href="/patient/login"
          className="flex min-h-14 items-center justify-center rounded-2xl border border-border bg-card text-lg font-semibold"
        >
          Patient login (phone OTP)
        </Link>
        <Link
          href="/login"
          className="flex min-h-14 items-center justify-center rounded-2xl border border-border bg-brand-soft text-lg font-semibold text-brand"
        >
          Staff login
        </Link>
        <Link
          href="/staff/register"
          className="text-center text-sm text-muted underline"
        >
          Staff first-time setup (invite code)
        </Link>
      </div>

      {isStaff(profile?.role) ? (
        <p className="text-center text-sm text-muted">Signed in as staff.</p>
      ) : null}
    </main>
  );
}
