import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { getActiveCampSnapshot } from "@/lib/camp";
import { SeatBoard } from "@/components/seat-board";
import { ActionCard, Card, StepList } from "@/components/ui";

export default async function HomePage() {
  const [session, snapshot] = await Promise.all([
    getSessionProfile(),
    getActiveCampSnapshot(),
  ]);
  const { profile } = session;
  if (profile?.role === "admin") redirect("/admin");
  if (profile?.role === "volunteer") redirect("/volunteer");
  if (profile?.role === "doctor") redirect("/doctor");
  if (profile?.role === "patient") redirect("/patient");

  const camp = snapshot;
  const days = snapshot?.days || [];
  const anyOpen = days.some((d) => !d.is_full);

  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-7 px-4 py-10 sm:max-w-3xl sm:px-6 lg:max-w-5xl lg:px-8 lg:py-14"
      style={{
        paddingBottom: "calc(2.5rem + var(--safe-bottom))",
        paddingTop: "calc(2rem + var(--safe-top))",
      }}
    >
      <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
        <div className="space-y-5 text-center lg:text-left">
          <div className="space-y-3">
            <div
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-[0.8125rem] font-bold tracking-widest text-white shadow-md lg:mx-0"
              aria-hidden="true"
            >
              SNP
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand">
                Sikar Nagarik Parishad &middot; Kolkata
              </p>
              <h1 className="mt-1 text-[2rem] font-bold tracking-tight text-foreground sm:text-4xl">
                Medical Camp Desk
              </h1>
              <p className="prose-help mx-auto mt-2 max-w-md leading-relaxed text-muted lg:mx-0">
                Multi-day eye camp with limited seats. Self-register with phone
                OTP, get your reg no, then doctor scan.
              </p>
            </div>
          </div>

          {camp ? (
            <Card
              padding="sm"
              className="bg-gradient-to-br from-brand-soft to-card"
            >
              <p className="text-[11px] font-bold uppercase tracking-wide text-brand">
                Active camp
              </p>
              <p className="mt-0.5 text-lg font-bold tracking-tight text-foreground">
                {camp.name}
              </p>
              {camp.venue ? (
                <p className="text-sm text-muted">{camp.venue}</p>
              ) : null}
            </Card>
          ) : (
            <p className="rounded-2xl border border-dashed border-border bg-card/60 px-4 py-5 text-sm text-muted">
              No active camp right now. Check back later, or ask staff.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <div className="sm:col-span-2 lg:col-span-1">
              <ActionCard
                href="/register"
                title="Register for camp"
                description={
                  !camp
                    ? "No active camp"
                    : anyOpen
                      ? "Phone OTP → details → reg no → signed in"
                      : "All days full"
                }
                variant="primary"
                disabled={!camp || !anyOpen}
                disabledReason={
                  !camp
                    ? "No active camp"
                    : "All days are full — try again later"
                }
              />
            </div>

            <ActionCard
              href="/patient/login"
              title="Patient login"
              description="Phone OTP or reg no + password"
              variant="secondary"
            />

            <ActionCard
              href="/login"
              title="Staff login"
              description="Admin · volunteers · doctors"
              variant="soft"
            />
          </div>

          <p className="text-center text-xs text-muted lg:text-left">
            First-time staff?{" "}
            <Link
              href="/staff/register"
              className="font-semibold text-brand underline decoration-brand/30 underline-offset-2 hover:decoration-brand"
            >
              Set up with invite code
            </Link>
          </p>

          {isStaff(profile?.role) ? (
            <p className="text-sm text-muted">Signed in as staff.</p>
          ) : null}

          <div className="pt-1 text-left">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
              How it works
            </p>
            <StepList
              steps={[
                {
                  title: "Phone OTP register",
                  detail: "Verify mobile · get reg no",
                },
                {
                  title: "Optional desk print",
                  detail: "Joins the FCFS queue",
                },
                {
                  title: "Doctor scan",
                  detail: "No print needed · seen once",
                },
              ]}
            />
          </div>
        </div>

        <div className="min-w-0">
          {camp ? (
            <SeatBoard
              days={days}
              campId={camp.id}
              title="Seats"
              compact
              pollMs={0}
            />
          ) : (
            <div className="hidden rounded-2xl border border-dashed border-border bg-card/50 p-10 text-center text-sm text-muted lg:block">
              Seat board appears when a camp is active.
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
