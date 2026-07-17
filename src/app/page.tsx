import Link from "next/link";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function HomePage() {
  const { profile } = await getSessionProfile();
  if (profile?.role === "admin") redirect("/admin");
  if (profile?.role === "volunteer") redirect("/volunteer");
  if (profile?.role === "patient") redirect("/patient");

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-7 px-4 py-10">
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
            Register patients, issue QR IDs, manage the queue, and print eye
            prescriptions — simple and fast at the desk.
          </p>
        </div>
      </div>

      <div className="grid gap-3">
        <Link
          href="/register"
          className="group flex min-h-[4.25rem] flex-col items-center justify-center rounded-2xl bg-brand px-4 py-3 text-white shadow-md transition hover:bg-brand-dark active:scale-[0.99]"
        >
          <span className="text-lg font-bold">Patient registration</span>
          <span className="text-xs font-medium text-white/80">
            Name → reg no + QR → join queue
          </span>
        </Link>

        <Link
          href="/patient/login"
          className="flex min-h-14 flex-col items-center justify-center rounded-2xl border border-border bg-card px-4 py-3 shadow-sm transition hover:border-brand/30 hover:bg-brand-soft"
        >
          <span className="text-base font-semibold">Patient login</span>
          <span className="text-xs text-muted">Phone OTP · view your QR</span>
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
