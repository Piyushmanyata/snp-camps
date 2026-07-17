"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui";

export function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  return (
    <Button
      type="button"
      variant="secondary"
      loading={loading}
      disabled={loading}
      onClick={async () => {
        setLoading(true);
        const supabase = createClient();
        await supabase.auth.signOut();
        router.replace("/");
        router.refresh();
      }}
    >
      {loading ? "Signing out…" : "Sign out"}
    </Button>
  );
}
