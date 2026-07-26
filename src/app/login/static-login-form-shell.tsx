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
      subtitle="Admin, volunteer, and doctor access"
      backHref="/"
      width="md"
      roleLabel="Staff"
    >
      <Card>
        <form method="post" className="space-y-4">
          <Input
            label="Email"
            type="email"
            name="email"
            required
            autoComplete="email"
            spellCheck={false}
            placeholder="you@example.com"
          />
          <Input
            label="Password"
            type="password"
            name="password"
            required
            autoComplete="current-password"
            placeholder="Your password"
          />
          <Button type="submit">Sign in</Button>
        </form>
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
