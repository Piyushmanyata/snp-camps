import Link from "next/link";
import { getSessionProfile, isStaff, roleHome } from "@/lib/auth";
import { getActiveCampSnapshotFresh } from "@/lib/camp";
import { deskPrintWindowOpen } from "@/lib/print-window";
import { Card, EmptyState, Shell } from "@/components/ui";
import { PatientForm } from "@/components/patient-form";
import { SignOutButton } from "@/components/sign-out";
import { RegisterSeatBoardLazy as SeatBoard } from "@/components/register-lazy";

export default async function RegisterPage() {
  const session = await getSessionProfile();
  const { userId, profile } = session;
  const role = profile?.role;

  const staff = isStaff(role);

  const deskHref = roleHome(role) || "/";

  const campPreview = staff ? await getActiveCampSnapshotFresh() : null;
  const volunteerWindowOpen = deskPrintWindowOpen(campPreview?.days || []);
  const staffDock =
    role === "volunteer" || role === "team_lead"
      ? volunteerWindowOpen
        ? [
            { href: "/register", label: "Register", primary: true as const },
            { href: "/volunteer", label: "Desk" },
            { href: "/volunteer#scan", label: "Scan" },
          ]
        : [
            { href: "/register", label: "Register", primary: true as const },
            { href: "/volunteer", label: "Desk" },
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
            <span lang="hi-Latn">
            Registration desk par hoti hai. Patient khud register karna chahein to{" "}
            <Link
              href="/self-register"
              className="font-semibold text-brand underline decoration-brand/30 underline-offset-2"
            >
              self-registration
            </Link>{" "}
            kholen.
            </span>
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

  const camp = campPreview;
  const days = camp?.days || [];

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
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-5 lg:items-start">
          <Card className="order-1 !p-4 sm:!p-5 lg:order-2 lg:col-span-3">
            <p
              lang="hi-Latn"
              className="prose-help mb-3 text-sm text-muted sm:mb-4"
            >
              Ek patient, ek din. Sirf naam aur umar zaroori. Register karein
              aur parchi print karein.
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
              <p className="break-words text-base font-bold tracking-tight sm:text-lg">
                {camp.name}
              </p>
              <p className="break-words text-sm text-muted">
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
