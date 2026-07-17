import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Shell({
  title,
  children,
  backHref,
}: {
  title: string;
  children: ReactNode;
  backHref?: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col px-4 py-6">
      <header className="mb-6 flex items-center gap-3">
        {backHref ? (
          <Link
            href={backHref}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium"
          >
            ← Back
          </Link>
        ) : null}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand">
            SNP Camps
          </p>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        </div>
      </header>
      {children}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      {children}
    </div>
  );
}

export function Button({
  className = "",
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
}) {
  const styles =
    variant === "primary"
      ? "bg-brand text-white hover:opacity-90"
      : variant === "danger"
        ? "bg-danger text-white hover:opacity-90"
        : "bg-brand-soft text-brand border border-border hover:bg-white";
  return (
    <button
      className={`inline-flex min-h-12 w-full items-center justify-center rounded-xl px-4 text-base font-semibold transition disabled:opacity-50 ${styles} ${className}`}
      {...props}
    />
  );
}

export function Input({
  label,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-muted">{label}</span>
      <input
        className={`min-h-12 w-full rounded-xl border border-border bg-white px-3 text-base outline-none ring-brand focus:ring-2 ${className}`}
        {...props}
      />
    </label>
  );
}

export function Select({
  label,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-muted">{label}</span>
      <select
        className="min-h-12 w-full rounded-xl border border-border bg-white px-3 text-base outline-none ring-brand focus:ring-2"
        {...props}
      >
        {children}
      </select>
    </label>
  );
}

export function ErrorBox({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}

export function Badge({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "ok" | "wait";
}) {
  const c =
    tone === "ok"
      ? "bg-brand-soft text-brand"
      : tone === "wait"
        ? "bg-amber-50 text-amber-800"
        : "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${c}`}>
      {children}
    </span>
  );
}
