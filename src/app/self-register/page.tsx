import { Card } from "@/components/ui";
import { SelfRegistrationFlowLazy } from "@/components/aadhaar-capture";
import { getActiveCampSnapshot } from "@/lib/camp";
import { connection } from "next/server";

export default async function SelfRegisterPage() {
  await connection();
  const camp = await getActiveCampSnapshot();
  const days = camp?.days.filter((day) => !day.is_full) ?? [];
  return (
    <main
      id="main"
      className="mx-auto w-full max-w-lg px-4 py-10 sm:px-6"
    >
      <Card>
        <p className="text-xs font-bold uppercase tracking-wide text-brand">
          SNP Medical Camp
        </p>
        <h1 className="mt-1 text-2xl font-bold">Self-registration</h1>
        {!camp || days.length === 0 ? (
          <p className="mt-5 text-sm text-muted">
            No camp days available right now. Please check back later.
          </p>
        ) : (
          <SelfRegistrationFlowLazy
            campId={camp.id}
            venue={camp.venue}
            days={camp.days}
          />
        )}
      </Card>
    </main>
  );
}
