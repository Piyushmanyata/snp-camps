import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { Badge, Card, Shell } from "@/components/ui";
import { QrCard } from "@/components/qr-card";
import { SignOutButton } from "@/components/sign-out";
import type { Patient } from "@/lib/types";

export default async function PatientHomePage() {
  const { userId, profile } = await getSessionProfile();
  if (!userId) redirect("/patient/login");

  const supabase = await createClient();
  const { data: patient } = await supabase
    .from("patients")
    .select(
      "id, reg_no, full_name, queue_status, gender, age, phone, address, aadhaar_last4",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const origin = process.env.NEXT_PUBLIC_SITE_URL || `${proto}://${host}`;

  return (
    <Shell title="My profile" backHref="/">
      <div className="space-y-4">
        {!patient ? (
          <Card>
            <p className="mb-3 text-muted">
              No registration linked to this phone yet.
            </p>
            <Link
              href="/register"
              className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-brand font-semibold text-white"
            >
              Register now
            </Link>
          </Card>
        ) : (
          <>
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xl font-bold">{patient.full_name}</p>
                  <p className="text-sm text-muted">
                    {[
                      patient.gender,
                      patient.age ? `${patient.age} yrs` : null,
                      patient.phone,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {patient.aadhaar_last4 ? (
                    <p className="text-xs text-muted">
                      Aadhaar ···· {patient.aadhaar_last4}
                    </p>
                  ) : null}
                </div>
                <Badge tone={patient.queue_status === "seen" ? "ok" : "wait"}>
                  {patient.queue_status === "seen" ? "Seen" : "Waiting"}
                </Badge>
              </div>
            </Card>
            <QrCard
              value={`${origin}/print/${patient.id}`}
              regNo={patient.reg_no}
            />
            {isStaff(profile?.role) ? (
              <Link
                href={`/print/${patient.id}`}
                className="inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-border bg-brand-soft font-semibold text-brand"
              >
                Open print form
              </Link>
            ) : null}
          </>
        )}
        <SignOutButton />
      </div>
    </Shell>
  );
}
