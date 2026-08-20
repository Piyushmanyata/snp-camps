import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getSessionProfile, roleHome } from "@/lib/auth";
import { getActiveCampSnapshot } from "@/lib/camp";
import { ActionCard, Card, StepList } from "@/components/ui";
import { SeatBoard } from "@/components/seat-board";

export default async function HomePage() {
  await connection();
  const [session, snapshot] = await Promise.all([
    getSessionProfile(),
    getActiveCampSnapshot(),
  ]);
  const { profile } = session;
  const home = roleHome(profile?.role);
  if (home) redirect(home);

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
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-[0.8125rem] font-bold tracking-widest text-white lg:mx-0"
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
              <p
                lang="hi-Latn"
                className="prose-help mx-auto mt-2 max-w-md leading-relaxed text-muted lg:mx-0"
              >
                Aankhon ka camp — seats limited hain. Online khud register
                karein, desk par parchi milegi.
              </p>
            </div>
          </div>

          {camp ? (
            <Card
              padding="sm"
              className="bg-brand-soft"
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
            <p
              lang="hi-Latn"
              className="rounded-2xl border border-dashed border-border bg-card/60 px-4 py-5 text-sm text-muted"
            >
              Abhi koi active camp nahi. Baad mein dekhein, ya staff se poochein.
            </p>
          )}

          <div lang="hi-Latn" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <ActionCard
              href="/self-register"
              title="Khud register karein"
              description={
                !camp
                  ? "Abhi koi camp nahi"
                  : anyOpen
                    ? "Aadhaar card se · desk par line nahi"
                    : "Sab din full hain — baad mein dekhein"
              }
              variant="primary"
              disabled={!camp || !anyOpen}
              disabledReason={
                !camp
                  ? "Abhi koi camp nahi"
                  : "Sab din full hain — baad mein dekhein"
              }
            />

            <ActionCard
              href="/login"
              title="Staff login"
              description="Admin · team lead · volunteer"
              variant="soft"
            />
          </div>

          <p lang="hi-Latn" className="text-center text-xs text-muted lg:text-left">
            Naye staff? Admin se account banwayein. Marij: Aadhaar card se khud
            register karein — login nahi chahiye.
          </p>

          <div lang="hi-Latn" className="pt-1 text-left">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
              Kaise hota hai
            </p>
            <StepList
              steps={[
                {
                  title: "Khud registration",
                  detail: "Aadhaar scan karein · reg number milega",
                },
                {
                  title: "Desk par parchi",
                  detail: "Desk aapki parchi print karega",
                },
                {
                  title: "Doctor se milna",
                  detail: "Staff QR scan karke seen karega",
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
