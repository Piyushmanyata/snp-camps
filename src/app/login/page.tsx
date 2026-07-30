import { Suspense } from "react";
import { headers } from "next/headers";
import { StaffLoginForm } from "./staff-login-form";
import { StaticLoginFormShell } from "./static-login-form-shell";

async function DynamicLoginForm() {
  await headers();
  return <StaffLoginForm />;
}

export default function StaffLoginPage() {
  return (
    <Suspense fallback={<StaticLoginFormShell />}>
      <DynamicLoginForm />
    </Suspense>
  );
}
