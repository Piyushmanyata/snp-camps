"use client";

import dynamic from "next/dynamic";
import { OpenOnToggle } from "@/components/ui";

/**
 * Non-critical admin tools load only when their collapsible is opened (#71).
 * Primary desk controls stay on the page; these panels are optional islands.
 */

const ChangePasswordCard = dynamic(
  () =>
    import("@/components/change-password-card").then((m) => ({
      default: m.ChangePasswordCard,
    })),
  {
    loading: () => (
      <p role="status" className="py-4 text-xs text-muted">
        Loading password settings…
      </p>
    ),
    ssr: false,
  },
);

export function ChangePasswordLazySection() {
  return (
    <OpenOnToggle title="Account security" hint="Change password">
      {(ready) =>
        ready ? (
          <ChangePasswordCard />
        ) : (
          <p role="status" className="py-4 text-xs text-muted">
            Open to load password settings…
          </p>
        )
      }
    </OpenOnToggle>
  );
}
