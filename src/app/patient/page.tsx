import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff } from "@/lib/auth";
import { Badge, Card, NavLink, Shell } from "@/components/ui";
import { QrCard } from "@/components/qr-card";
import { SignOutButton } from "@/components/sign-out";

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
    <Shell title="My profile" subtitle="Your camp registration" backHref="/">
      <div className="space-y-4">
        {!patient ? (
          <Card>
            <p className="mb-1 font-semibold">No registration linked yet</p>
            <p className="mb-4 text-sm text-muted">
              Register for today’s camp to get your reg number and QR.
            </p>
            <NavLink href="/register">Register now</NavLink>
          </Card>
        ) : (
          <>
            <Card className="bg-gradient-to-br from-brand-soft/70 to-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xl font-bold tracking-tight">
                    {patient.full_name}
                  </p>
                  <p className="mt-0.5 text-sm text-muted">
                    {[
                      patient.gender,
                      patient.age ? `${patient.age} yrs` : null,
                      patient.phone,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {patient.aadhaar_last4 ? (
                    <p className="mt-1 text-xs text-muted">
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
              patientId={patient.id}
            />
            {isStaff(profile?.role) ? (
              <NavLink href={`/print/${patient.id}`} variant="soft">
                Open print form
              </NavLink>
            ) : null}
          </>
        )}
        <SignOutButton />
      </div>
    </Shell>
  );
}
