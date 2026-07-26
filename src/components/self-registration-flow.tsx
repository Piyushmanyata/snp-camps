"use client";

import { useState } from "react";
import { digitsOnly, isValidAadhaarNumber, type AadhaarProfile } from "@/lib/aadhaar";
import { formatCampDay, type CampDayStats } from "@/lib/types";

type Props = { campId: string; venue: string | null; days: CampDayStats[] };

function formatAadhaar(value: string) {
  return digitsOnly(value).slice(0, 12).replace(/(.{4})/g, "$1 ").trim();
}

export function SelfRegistrationFlow({ campId, venue, days }: Props) {
  const [step, setStep] = useState<"aadhaar" | "otp" | "confirm" | "success">("aadhaar");
  const [aadhaar, setAadhaar] = useState("");
  const [handle, setHandle] = useState("");
  const [maskedMobile, setMaskedMobile] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [profile, setProfile] = useState<AadhaarProfile | null>(null);
  const [dayId, setDayId] = useState(days.find((day) => !day.is_full)?.id ?? "");
  const [result, setResult] = useState<{ registrationNumber: number; statusUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(path: string, body: Record<string, unknown>) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  }

  async function initiate() {
    const digits = digitsOnly(aadhaar);
    if (!isValidAadhaarNumber(digits)) {
      setError("Aadhaar number galat hai. 12 digits dobara check karein.");
      return;
    }
    setBusy(true); setError(null);
    try {
      const body = await post("/api/aadhaar-kyc/initiate", { aadhaar: digits });
      if (body.ok !== true || typeof body.handle !== "string") {
        setError(typeof body.error === "string" ? body.error : "Verification abhi unavailable hai.");
        return;
      }
      setHandle(body.handle);
      setMaskedMobile(typeof body.maskedMobile === "string" ? body.maskedMobile : null);
      setAadhaar("");
      setStep("otp");
    } finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true); setError(null);
    try {
      const body = await post("/api/aadhaar-kyc/verify", { handle, otp });
      if (body.ok !== true || !body.profile) {
        setError(typeof body.error === "string" ? body.error : "OTP verify nahi hua. Dobara try karein.");
        if (body.restart === true) { setStep("aadhaar"); setHandle(""); }
        return;
      }
      setProfile(body.profile as AadhaarProfile);
      setStep("confirm");
    } finally { setBusy(false); }
  }

  async function register() {
    if (!dayId) { setError("Ek Camp Day chunna zaroori hai."); return; }
    setBusy(true); setError(null);
    try {
      const body = await post("/api/self-registration", { handle, campId, campDayId: dayId });
      if (body.ok !== true || typeof body.statusUrl !== "string" || typeof body.registrationNumber !== "number") {
        setError(typeof body.error === "string" ? body.error : "Registration nahi ho paaya. Camp desk par madad lein.");
        return;
      }
      setResult({ registrationNumber: body.registrationNumber, statusUrl: body.statusUrl });
      setStep("success");
    } finally { setBusy(false); }
  }

  if (step === "success" && result) return (
    <section aria-labelledby="registration-success" className="space-y-5">
      <h2 id="registration-success" className="text-xl font-bold">Registration ho gaya</h2>
      <p className="text-sm text-muted">Aap registered hain, abhi queue mein nahi. Aane par camp desk par check-in karein.</p>
      <p className="rounded-2xl bg-brand-soft p-6 text-center"><span className="block text-xs font-bold uppercase text-brand">Registration number</span><strong className="text-5xl tracking-tight">#{result.registrationNumber}</strong></p>
      <p className="text-sm">Camp SMS Aadhaar-linked number par aayega. Number badal gaya ho to desk par batayein.</p>
      <a className="block break-all rounded-xl border border-border p-3 text-sm font-semibold text-brand underline" href={result.statusUrl}>{result.statusUrl}</a>
    </section>
  );

  return <section aria-labelledby="self-registration-form" className="space-y-5">
    {error ? <p role="alert" className="rounded-xl border border-red-200 bg-danger-soft p-3 text-sm text-danger">{error}</p> : null}
    {step === "aadhaar" ? <>
      <h2 id="self-registration-form" className="text-lg font-bold">Aadhaar se verify karein</h2>
      <p className="text-sm text-muted">Aadhaar-linked mobile par OTP aayega. Full number yahan ke baad store nahi hota.</p>
      <label className="block text-sm font-semibold" htmlFor="aadhaar">Aadhaar number</label>
      <input id="aadhaar" inputMode="numeric" autoComplete="off" value={formatAadhaar(aadhaar)} onChange={(event) => setAadhaar(event.target.value)} className="min-h-12 w-full rounded-xl border border-border px-3 text-lg tracking-widest" />
      <button type="button" disabled={busy} onClick={initiate} className="min-h-12 w-full rounded-xl bg-brand px-4 font-bold text-white disabled:opacity-50">{busy ? "Bhej rahe hain…" : "OTP bhejein"}</button>
    </> : null}
    {step === "otp" ? <>
      <h2 className="text-lg font-bold">OTP daalein</h2>
      <p className="text-sm text-muted">OTP {maskedMobile || "Aadhaar-linked mobile"} par bheja gaya hai.</p>
      <label className="block text-sm font-semibold" htmlFor="otp">6-digit OTP</label>
      <input id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} className="min-h-12 w-full rounded-xl border border-border px-3 text-lg tracking-widest" />
      <button type="button" disabled={busy || otp.length !== 6} onClick={verify} className="min-h-12 w-full rounded-xl bg-brand px-4 font-bold text-white disabled:opacity-50">{busy ? "Check kar rahe hain…" : "Verify OTP"}</button>
    </> : null}
    {step === "confirm" && profile ? <>
      <h2 className="text-lg font-bold">Details confirm karein</h2>
      <dl className="space-y-3 rounded-xl border border-border p-4 text-sm">
        {([["Name", profile.full_name], ["Age", profile.age], ["Gender", profile.gender], ["Address", profile.address], ["Phone", profile.phone]] as const).map(([label, value]) => <div key={label}><dt className="text-muted">{label}</dt><dd className="font-semibold">{value || "—"}</dd></div>)}
      </dl>
      <p className="text-sm text-muted">Details Aadhaar se aaye hain aur edit nahi kiye ja sakte. Galti ho to desk par correction karayein.</p>
      <label className="block text-sm font-semibold" htmlFor="camp-day">Camp Day</label>
      <select id="camp-day" value={dayId} onChange={(event) => setDayId(event.target.value)} className="min-h-12 w-full rounded-xl border border-border px-3">
        {days.filter((day) => !day.is_full).map((day) => <option key={day.id} value={day.id}>{formatCampDay(day.day_date)} · {day.seats_left} seats left</option>)}
      </select>
      <p className="text-sm text-muted">Camp: {venue || "venue TBA"}. SMS Aadhaar-linked number par aayega; desk phone update kar sakta hai.</p>
      <button type="button" disabled={busy} onClick={register} className="min-h-12 w-full rounded-xl bg-brand px-4 font-bold text-white disabled:opacity-50">{busy ? "Register kar rahe hain…" : "Confirm registration"}</button>
    </> : null}
  </section>;
}
