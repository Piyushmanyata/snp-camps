import Link from "next/link";
import { Card, Shell } from "@/components/ui";

export default async function QrHelpPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;

  return (
    <Shell
      title="Show this at the desk"
      subtitle="QR codes are for camp staff"
      backHref="/"
      width="md"
    >
      <Card className="space-y-3 text-center">
        <p className="text-base font-semibold">
          This QR does not log you in on your phone.
        </p>
        <p className="text-sm text-muted">
          Please show your registration number or QR to desk staff. They will
          print your prescription (you join the queue) and later scan it when a
          doctor sees you.
        </p>
        {id ? (
          <p className="rounded-xl bg-background px-3 py-2 font-mono text-xs text-muted break-all">
            Ref: {id}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 pt-1">
          <Link
            href="/patient/login"
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand"
          >
            Patient login (reg no)
          </Link>
          <Link
            href="/register"
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-white"
          >
            Register for camp
          </Link>
        </div>
      </Card>
    </Shell>
  );
}
