"use client";

import Link from "next/link";
import { Button } from "@/components/ui";

export function PrintActions({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      <Button type="button" className="w-auto min-w-40" onClick={() => window.print()}>
        Print prescription
      </Button>
      <Link
        href="/volunteer"
        className="inline-flex min-h-12 items-center justify-center rounded-xl border border-border bg-brand-soft px-4 font-semibold text-brand"
      >
        Back to desk
      </Link>
    </div>
  );
}
