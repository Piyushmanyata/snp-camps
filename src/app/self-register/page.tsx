import { Card } from "@/components/ui";
import { SelfRegistrationFlow } from "@/components/self-registration-flow";
import { getActiveCampSnapshot } from "@/lib/camp";

/**
 * Self-registration is always on (#113). The old "unavailable unless an eKYC
 * provider is configured" gate went with the OTP flow (#116 / ADR 0004) — a
 * card scan needs no provider, no OTP and no SMS.
 */
export default async function SelfRegisterPage() {
  const camp = await getActiveCampSnapshot();
  const days = camp?.days.filter((day) => !day.is_full) ?? [];
  return (
    <main id="main" className="mx-auto w-full max-w-lg px-4 py-10 sm:px-6">
      <Card>
        <p className="text-xs font-bold uppercase tracking-wide text-brand">
          SNP Medical Camp
        </p>
        <h1 className="mt-1 text-2xl font-bold">Self-registration</h1>
        {!camp || days.length === 0 ? (
          <p className="mt-5 text-sm text-muted">
            Abhi koi Camp Day available nahi hai. Kripya baad mein try karein.
          </p>
        ) : (
          <SelfRegistrationFlow campId={camp.id} venue={camp.venue} days={camp.days} />
        )}
      </Card>
    </main>
  );
}
