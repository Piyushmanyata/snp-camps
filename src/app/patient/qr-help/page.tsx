import Link from "next/link";
import { Card, InfoBox, Shell } from "@/components/ui";

export default async function QrHelpPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;

  return (
    <Shell
      title="Show this at the desk"
      subtitle="QR codes are for camp staff only"
      backHref="/"
      width="md"
    >
      <Card className="space-y-4 text-center">
        <p className="text-base font-semibold tracking-tight">
          This QR does not log you in.
        </p>
        <InfoBox>
          Please show your registration number or QR to a volunteer or doctor.
          Staff scan it to print your form or assign a doctor — it is not a
          phone login code.
        </InfoBox>
        {id ? (
          <p className="rounded-xl bg-background px-3 py-2 font-mono text-xs text-muted break-all">
            Ref: {id}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 pt-1">
          <Link
            href="/patient/login"
            className="pressable inline-flex min-h-12 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand shadow-sm hover:bg-brand-soft"
          >
            Patient login (reg no + password)
          </Link>
          <Link
            href="/register"
            className="pressable inline-flex min-h-12 items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-white shadow-sm hover:bg-brand-dark"
          >
            Register for camp
          </Link>
        </div>
      </Card>
    </Shell>
  );
}
