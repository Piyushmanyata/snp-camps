"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";

export default function PatientLookupPage() {
  const router = useRouter();
  const [regNo, setRegNo] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ regNo: regNo.trim(), dateOfBirth: dateOfBirth.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.ok && data.redirectUrl) {
        router.push(data.redirectUrl);
      } else {
        setError(data.error || "Registration details did not match our records.");
        setLoading(false);
      }
    } catch {
      setError("Registration details did not match our records.");
      setLoading(false);
    }
  }

  return (
    <main id="main" className="mx-auto max-w-md px-4 py-10 text-foreground">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-brand">Patient Lookup</h1>
          <p className="mt-1 text-sm text-muted">
            Enter your registration number and date of birth to check your live camp queue status.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm">
          {error ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-950">
              {error}
            </div>
          ) : null}

          <Input
            id="lookup-reg-no"
            label="Registration Number *"
            type="number"
            min={1}
            required
            inputMode="numeric"
            value={regNo}
            onChange={(e) => setRegNo(e.target.value)}
            placeholder="e.g. 101"
          />

          <Input
            id="lookup-dob"
            label="Date of Birth *"
            type="date"
            required
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.target.value)}
          />

          <Button type="submit" variant="primary" disabled={loading} className="w-full min-h-12 text-base font-semibold">
            {loading ? "Searching…" : "Find My Status"}
          </Button>
        </form>

        <div className="text-center">
          <Link href="/" className="text-sm font-semibold text-brand hover:underline">
            ← Back to Home
          </Link>
        </div>
      </div>
    </main>
  );
}
