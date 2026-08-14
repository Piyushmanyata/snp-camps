import Link from "next/link";
import {
  Button,
  Card,
  InfoBox,
  Input,
  Shell,
} from "@/components/ui";

export function StaticLoginFormShell() {
  return (
    <Shell
      title="Staff login"
      subtitle="Admin and camp staff access"
      backHref="/"
      width="md"
      roleLabel="Staff"
    >
      <Card>
        <div
          className="space-y-4"
          aria-busy="true"
          aria-label="Loading sign-in form"
          data-testid="static-login-shell"
        >
          <Input
            label="Email"
            type="email"
            name="email"
            disabled
            autoComplete="email"
            spellCheck={false}
            placeholder="you@example.com"
          />
          <Input
            label="Password"
            type="password"
            name="password"
            disabled
            autoComplete="current-password"
            placeholder="Your password"
          />
          <Button type="button" disabled>
            Sign in
          </Button>
        </div>
      </Card>

      <div className="mt-4 space-y-3">
        <InfoBox>
          Need an account? Ask an admin to create one for you. Patients
          register at the camp desk and check status via the SMS link when
          available — there is no patient login.
        </InfoBox>
        <p className="text-center text-sm text-muted">
          <Link
            href="/"
            className="font-semibold text-brand underline decoration-brand/30 underline-offset-2"
          >
            Back to home
          </Link>
        </p>
      </div>
    </Shell>
  );
}
