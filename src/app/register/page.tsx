import Link from "next/link";
import { getSessionProfile, isStaff, roleHome } from "@/lib/auth";
import { getActiveCampSnapshotFresh } from "@/lib/camp";
import { Card, EmptyState, Shell } from "@/components/ui";
import { PatientForm } from "@/components/patient-form";
import { SignOutButton } from "@/components/sign-out";
import { SeatBoard } from "@/components/seat-board";

export default async function RegisterPage() {
  const [session, camp] = await Promise.all([
    getSessionProfile(),
    getActiveCampSnapshotFresh(),
  ]);
  const { userId, profile } = session;
  const days = camp?.days || [];
  const role = profile?.role;

  const staff = isStaff(role);

  // One routing table, not two (D5) — roleHome() is the single source.
  const deskHref = roleHome(role) || "/";

  const staffDock =
    role === "volunteer" || role === "team_lead"
      ? [
          { href: "/register", label: "Register", primary: true as const },
          { href: "/volunteer", label: "Desk" },
          { href: "/volunteer#scan", label: "Scan" },
        ]
      : role === "admin"
        ? [
            { href: "/register", label: "Register", primary: true as const },
            { href: "/admin", label: "Admin" },
            { href: "/admin/patients", label: "Patients" },
          ]
        : undefined;

  if (!staff) {
    return (
      <Shell
        title="Register patient"
        subtitle="Desk registration only"
        backHref="/"
        width="lg"
      >
        <Card>
          <EmptyState>
            Registration is at the camp desk only. Please go to a volunteer —
            there is no public online registration or patient login.
          </EmptyState>
          <Link
            href="/"
            className="mt-3 inline-flex text-sm font-semibold text-brand underline decoration-brand/30 underline-offset-2"
          >
            Back to home
          </Link>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell
      title="Register"
      subtitle="Desk · poora naam + umar zaroori · baaki optional"
      backHref={deskHref}
      width="lg"
      roleLabel={role === "admin" ? "Admin" : role === "team_lead" ? "Team Lead" : "Volunteer"}
      actions={<SignOutButton place="header" />}
      dock={staffDock}
    >
      {!camp ? (
        <Card>
          <EmptyState>
            No active camp. Ask admin to create or activate a camp first.
          </EmptyState>
          {profile?.role === "admin" ? (
            <Link
              href="/admin"
              className="mt-3 inline-flex text-sm font-semibold text-brand underline decoration-brand/30 underline-offset-2"
            >
              Go to admin
            </Link>
          ) : null}
        </Card>
      ) : (
        <div className="grid gap-3 sm:gap-4 lg:grid-cols-5 lg:items-start">
          {/* Form first on phone — speed for walk-ins */}
          <Card className="order-1 !p-4 sm:!p-5 lg:order-2 lg:col-span-3">
            <p className="prose-help mb-3 text-sm text-muted sm:mb-4">
              Ek patient, ek din. Sirf naam aur umar zaroori. Register karein
              aur print — aaj ka din ho to seedha line mein.
            </p>
            <PatientForm
              campId={camp.id}
              days={days}
              createdBy={userId}
              isStaff
              userRole={role}
              defaultPhone=""
            />
          </Card>

          <div className="order-2 space-y-3 sm:space-y-4 lg:order-1 lg:col-span-2">
            <Card className="bg-brand-soft !p-4 sm:!p-5">
              <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand sm:text-[11px]">
                Active camp
              </p>
              <p className="text-base font-bold tracking-tight sm:text-lg">
                {camp.name}
              </p>
              <p className="text-sm text-muted">
                {camp.venue || "Registration"}
              </p>
            </Card>
            <SeatBoard
              days={days}
              campId={camp.id}
              title="Seat board"
              compact
              pollMs={0}
            />
          </div>
        </div>
      )}
    </Shell>
  );
}
