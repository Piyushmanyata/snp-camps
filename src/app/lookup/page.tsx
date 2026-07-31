"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, ErrorBox, Input } from "@/components/ui";

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
        return;
      }
      setError(data.error || "Ye registration number aur janm tithi match nahi hui.");
    } catch {
      setError("Ye registration number aur janm tithi match nahi hui.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main id="main" className="mx-auto max-w-md px-4 py-10 text-foreground">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-brand">
            Apna status dekhein
          </h1>
          <p className="mt-1 text-[0.9375rem] text-muted">
            Apna registration number aur janm tithi daalein — aapko apna live
            camp status mil jayega.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-2xl border border-border bg-card p-5"
        >
          <ErrorBox message={error} />

          <Input
            id="lookup-reg-no"
            label="Registration number"
            type="number"
            min={1}
            required
            inputMode="numeric"
            value={regNo}
            onChange={(e) => setRegNo(e.target.value)}
            placeholder="jaise 101"
          />

          <Input
            id="lookup-dob"
            label="Janm tithi (date of birth)"
            type="date"
            required
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.target.value)}
          />

          <Button type="submit" variant="primary" loading={loading}>
            {loading ? "Dhoondh rahe hain…" : "Status dekhein"}
          </Button>
        </form>

        <div className="text-center">
          <Link
            href="/"
            className="inline-flex min-h-12 items-center text-[0.9375rem] font-semibold text-brand hover:underline"
          >
            ← Wapas home
          </Link>
        </div>
      </div>
    </main>
  );
}
