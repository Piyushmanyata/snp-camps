import Link from "next/link";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";

const shellWidths = {
  sm: "max-w-lg",
  md: "max-w-2xl",
  lg: "max-w-4xl",
  xl: "max-w-6xl",
} as const;

export function Shell({
  title,
  subtitle,
  children,
  backHref,
  actions,
  width = "sm",
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  backHref?: string;
  actions?: ReactNode;
  /** Desktop content width. Mobile stays full-bleed with padding. */
  width?: keyof typeof shellWidths;
}) {
  return (
    <div
      className={`mx-auto flex w-full flex-1 flex-col px-4 py-5 sm:px-6 sm:py-7 lg:px-8 ${shellWidths[width]}`}
    >
      <header className="mb-5 flex items-start gap-3 sm:mb-6">
        {backHref ? (
          <Link
            href={backHref}
            className="mt-0.5 inline-flex h-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card px-3 text-sm font-medium text-foreground shadow-sm transition hover:bg-brand-soft"
            aria-label="Go back"
          >
            ←
          </Link>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand">
            SNP Camps
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-[1.75rem]">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-0.5 text-sm text-muted">{subtitle}</p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function Card({
  children,
  className = "",
  padding = "md",
}: {
  children: ReactNode;
  className?: string;
  padding?: "sm" | "md" | "lg";
}) {
  const p =
    padding === "sm" ? "p-4" : padding === "lg" ? "p-6" : "p-5";
  return (
    <div
      className={`rounded-2xl border border-border/80 bg-card shadow-[var(--shadow-card)] ${p} ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-2">
      <h2 className="text-base font-semibold tracking-tight">{children}</h2>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </div>
  );
}

export function Button({
  className = "",
  variant = "primary",
  size = "md",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
}) {
  const sizes = size === "sm" ? "min-h-10 px-3 text-sm" : "min-h-12 px-4 text-base";
  const styles =
    variant === "primary"
      ? "bg-brand text-white shadow-sm hover:bg-brand-dark active:scale-[0.99]"
      : variant === "danger"
        ? "bg-danger text-white hover:opacity-90"
        : variant === "ghost"
          ? "bg-transparent text-muted hover:bg-brand-soft hover:text-brand"
          : "border border-border bg-brand-soft text-brand hover:bg-white";
  return (
    <button
      className={`inline-flex w-full items-center justify-center gap-2 rounded-xl font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${sizes} ${styles} ${className}`}
      {...props}
    />
  );
}

export function Input({
  label,
  className = "",
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-foreground/80">{label}</span>
      <input
        className={`min-h-12 w-full rounded-xl border border-border bg-white px-3.5 text-base text-foreground shadow-sm outline-none transition placeholder:text-muted/60 focus:border-brand focus:ring-2 focus:ring-brand/20 ${className}`}
        {...props}
      />
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
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
      <span className="text-sm font-medium text-foreground/80">{label}</span>
      <select
        className="min-h-12 w-full rounded-xl border border-border bg-white px-3.5 text-base shadow-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
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
    <p
      role="alert"
      className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-danger"
    >
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
      ? "bg-brand-soft text-brand ring-1 ring-brand/15"
      : tone === "wait"
        ? "bg-amber-50 text-amber-900 ring-1 ring-amber-200/80"
        : "bg-gray-100 text-gray-700 ring-1 ring-gray-200/80";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${c}`}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | string;
  tone?: "default" | "ok" | "wait";
}) {
  const accent =
    tone === "ok"
      ? "text-brand"
      : tone === "wait"
        ? "text-amber-700"
        : "text-brand-dark";
  return (
    <div className="rounded-2xl border border-border/80 bg-card p-3 text-center shadow-[var(--shadow-card)]">
      <p className={`text-2xl font-bold tabular-nums tracking-tight ${accent}`}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
      </p>
    </div>
  );
}

export function NavLink({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "soft";
}) {
  const styles =
    variant === "primary"
      ? "bg-brand text-white shadow-sm hover:bg-brand-dark"
      : variant === "soft"
        ? "border border-border bg-brand-soft font-semibold text-brand hover:bg-white"
        : "border border-border bg-card font-semibold text-foreground hover:bg-brand-soft";
  return (
    <Link
      href={href}
      className={`inline-flex min-h-12 w-full items-center justify-center rounded-xl px-4 text-base font-semibold transition active:scale-[0.99] ${styles}`}
    >
      {children}
    </Link>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border bg-background/60 px-3 py-4 text-center text-sm text-muted">
      {children}
    </p>
  );
}
