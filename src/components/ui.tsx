import Link from "next/link";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

const shellWidths = {
  sm: "max-w-lg",
  md: "max-w-2xl",
  lg: "max-w-4xl",
  xl: "max-w-6xl",
} as const;

export type DockItem = {
  href: string;
  label: string;
  /** Primary CTA gets solid brand fill */
  primary?: boolean;
};

/** Sticky bottom action bar for field desk pages (mobile only). */
export function MobileDock({
  items,
  label = "Quick actions",
}: {
  items: DockItem[];
  label?: string;
}) {
  if (!items.length) return null;
  const cols = Math.min(items.length, 3);
  return (
    <nav className="mobile-dock no-print" aria-label={label}>
      <div
        className="mobile-dock-inner"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        }}
      >
        {items.map((item) => (
          <Link
            key={item.href + item.label}
            href={item.href}
            className={`pressable inline-flex items-center justify-center rounded-xl px-2 text-center text-sm font-bold transition-colors duration-150 ${
              item.primary
                ? "bg-brand text-white shadow-sm hover:bg-brand-dark"
                : "border border-border bg-card text-foreground hover:bg-brand-soft hover:text-brand"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** Page chrome: brand mark, title, optional back + actions. Mobile-first. */
export function Shell({
  title,
  subtitle,
  children,
  backHref,
  actions,
  width = "sm",
  roleLabel,
  dock,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  backHref?: string;
  actions?: ReactNode;
  /** Desktop content width. Mobile stays full-bleed with padding. */
  width?: keyof typeof shellWidths;
  /** Optional role chip (Admin, Volunteer, Doctor, Patient) */
  roleLabel?: string;
  /** Mobile sticky bottom actions (hidden on desktop) */
  dock?: DockItem[];
}) {
  const hasDock = Boolean(dock?.length);
  return (
    <>
      <div
        className={`mx-auto flex w-full flex-1 flex-col px-4 pt-4 sm:px-6 sm:pt-6 lg:px-8 ${shellWidths[width]} ${
          hasDock ? "has-mobile-dock" : "pb-8 sm:pb-10"
        }`}
        style={{
          paddingTop: "calc(1rem + var(--safe-top))",
          ...(hasDock
            ? {}
            : { paddingBottom: "calc(2rem + var(--safe-bottom))" }),
        }}
      >
        <header className="mb-5 flex items-start gap-3 sm:mb-6">
          {backHref ? (
            <Link
              href={backHref}
              className="pressable mt-0.5 inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-lg font-semibold text-foreground shadow-sm hover:border-brand/25 hover:bg-brand-soft"
              aria-label="Go back"
            >
              <span aria-hidden="true">←</span>
            </Link>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand">
                SNP Camps
              </p>
              {roleLabel ? (
                <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-brand ring-1 ring-brand/15">
                  {roleLabel}
                </span>
              ) : null}
            </div>
            <h1 className="mt-0.5 text-[1.7rem] font-bold tracking-tight text-foreground sm:text-[1.9rem]">
              {title}
            </h1>
            {subtitle ? (
              <p className="prose-help mt-1 text-muted">{subtitle}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-start gap-2">{actions}</div>
          ) : null}
        </header>
        <main id="main" className="flex flex-1 flex-col">
          {children}
        </main>
      </div>
      {hasDock && dock ? <MobileDock items={dock} /> : null}
    </>
  );
}

export function Card({
  children,
  className = "",
  padding = "md",
  id,
}: {
  children: ReactNode;
  className?: string;
  padding?: "sm" | "md" | "lg" | "none";
  id?: string;
}) {
  const p =
    padding === "none"
      ? ""
      : padding === "sm"
        ? "p-4"
        : padding === "lg"
          ? "p-6"
          : "p-5";
  return (
    <div
      id={id}
      className={`rounded-2xl border border-border/90 bg-card shadow-[var(--shadow-card)] ${p} ${className}`}
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
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        {children}
      </h2>
      {hint ? (
        <span className="shrink-0 text-[0.8125rem] text-muted">{hint}</span>
      ) : null}
    </div>
  );
}

/** Native collapsible panel — keeps long dashboards scannable. */
export function CollapsibleSection({
  title,
  hint,
  children,
  defaultOpen = false,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen || undefined}
      className="group rounded-2xl border border-border/90 bg-card shadow-[var(--shadow-card)]"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {hint ? (
            <span className="text-[0.8125rem] text-muted">{hint}</span>
          ) : null}
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted transition group-open:rotate-180"
            aria-hidden="true"
          >
            ▾
          </span>
        </span>
      </summary>
      <div className="border-t border-border px-5 pb-5 pt-4">{children}</div>
    </details>
  );
}

export function Button({
  className = "",
  variant = "primary",
  size = "md",
  loading = false,
  children,
  disabled,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  loading?: boolean;
}) {
  const sizes =
    size === "sm"
      ? "min-h-12 px-3.5 text-[0.9375rem]"
      : "min-h-[3.25rem] px-4 text-[1.0625rem]";
  const styles =
    variant === "primary"
      ? "bg-brand text-white shadow-sm hover:bg-brand-dark"
      : variant === "danger"
        ? "bg-danger text-white hover:bg-danger/90"
        : variant === "ghost"
          ? "bg-transparent text-muted hover:bg-brand-soft hover:text-brand"
          : "border border-border bg-brand-soft text-brand hover:bg-white hover:border-brand/30";
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`pressable inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${sizes} ${styles} ${className}`}
      {...props}
    >
      {loading ? (
        <>
          <Spinner className="h-4 w-4" />
          <span>{typeof children === "string" ? children : "Working…"}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z"
      />
    </svg>
  );
}

export function Input({
  label,
  className = "",
  hint,
  id,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string | null;
}) {
  const inputId =
    id ||
    (typeof label === "string"
      ? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
      : undefined);
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <label className="block space-y-1.5" htmlFor={inputId}>
      <span className="text-[0.9375rem] font-semibold text-foreground/90">
        {label}
      </span>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [errorId, hintId].filter(Boolean).join(" ") || undefined
        }
        className={`min-h-[3.25rem] w-full rounded-xl border bg-white px-3.5 text-[1.0625rem] text-foreground shadow-sm outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted/55 focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:bg-background disabled:opacity-70 ${
          error
            ? "border-danger focus:border-danger focus:ring-danger/20"
            : "border-border"
        } ${className}`}
        {...props}
      />
      {error ? (
        <span
          id={errorId}
          className="block text-[0.8125rem] font-medium text-danger"
        >
          {error}
        </span>
      ) : null}
      {hint ? (
        <span id={hintId} className="block text-[0.8125rem] text-muted">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function Select({
  label,
  children,
  id,
  hint,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const selectId =
    id ||
    (typeof label === "string"
      ? `select-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
      : undefined);
  const hintId = hint ? `${selectId}-hint` : undefined;

  return (
    <label className="block space-y-1.5" htmlFor={selectId}>
      <span className="text-[0.9375rem] font-semibold text-foreground/90">
        {label}
      </span>
      <select
        id={selectId}
        aria-describedby={hintId}
        className="min-h-[3.25rem] w-full cursor-pointer rounded-xl border border-border bg-white px-3.5 text-[1.0625rem] text-foreground shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-70"
        {...props}
      >
        {children}
      </select>
      {hint ? (
        <span id={hintId} className="block text-[0.8125rem] text-muted">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function ErrorBox({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-xl border border-red-200 bg-danger-soft px-3.5 py-3 text-[0.9375rem] text-danger"
    >
      <p className="font-medium">{message}</p>
    </div>
  );
}

export function SuccessBox({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-xl border border-brand/20 bg-success-soft px-3.5 py-3 text-[0.9375rem] text-brand"
    >
      <p className="font-medium">{message}</p>
    </div>
  );
}

export function InfoBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-background/80 px-3.5 py-3 text-[0.9375rem] text-muted">
      {children}
    </div>
  );
}

export function WarningBox({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-xl border border-amber-200 bg-warning-soft px-3.5 py-3 text-[0.9375rem] text-warning"
    >
      {children}
    </div>
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
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[0.8125rem] font-semibold ${c}`}
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
    <div className="rounded-2xl border border-border/80 bg-card p-3.5 text-center shadow-[var(--shadow-card)]">
      <p
        className={`tabular text-[1.75rem] font-bold tracking-tight sm:text-[1.85rem] ${accent}`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-muted">
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
        ? "border border-border bg-brand-soft font-semibold text-brand hover:bg-white hover:border-brand/30"
        : "border border-border bg-card font-semibold text-foreground hover:bg-brand-soft";
  return (
    <Link
      href={href}
      className={`pressable inline-flex min-h-[3.25rem] w-full cursor-pointer items-center justify-center rounded-xl px-4 text-[1.0625rem] font-semibold transition-colors duration-150 ${styles}`}
    >
      {children}
    </Link>
  );
}

/** Large home / hub action card — primary path or secondary path. */
export function ActionCard({
  href,
  title,
  description,
  variant = "primary",
  disabled = false,
  disabledReason,
}: {
  href: string;
  title: string;
  description: string;
  variant?: "primary" | "secondary" | "soft";
  disabled?: boolean;
  disabledReason?: string;
}) {
  if (disabled) {
    return (
      <div
        className="flex min-h-[5rem] flex-col items-center justify-center rounded-2xl border border-border bg-gray-100 px-4 py-4 text-center opacity-80 sm:items-start sm:text-left"
        aria-disabled="true"
      >
        <span className="text-xl font-bold text-gray-500">{title}</span>
        <span className="mt-0.5 text-[0.8125rem] font-medium text-gray-500">
          {disabledReason || description}
        </span>
      </div>
    );
  }

  const styles =
    variant === "primary"
      ? "bg-brand text-white shadow-md hover:bg-brand-dark hover:shadow-[var(--shadow-lift)]"
      : variant === "soft"
        ? "border border-brand/20 bg-brand-soft text-brand hover:bg-white hover:border-brand/35"
        : "border border-border bg-card text-foreground shadow-sm hover:border-brand/30 hover:bg-brand-soft";

  const descClass =
    variant === "primary" ? "text-white/90" : "text-muted";

  return (
    <Link
      href={href}
      className={`pressable group flex min-h-[5rem] flex-col items-center justify-center rounded-2xl px-4 py-4 text-center transition-colors duration-150 sm:items-start sm:text-left ${styles}`}
    >
      <span className="text-xl font-bold tracking-tight">{title}</span>
      <span className={`mt-0.5 text-[0.8125rem] font-medium ${descClass}`}>
        {description}
      </span>
    </Link>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-background/70 px-4 py-6 text-center">
      <p className="text-sm text-muted">{children}</p>
    </div>
  );
}

/** Segmented control for 2–4 mutually exclusive options (login modes, filters). */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label || "Options"}
      className="grid gap-1 rounded-xl bg-background p-1"
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(opt.value)}
            className={`pressable min-h-12 cursor-pointer rounded-lg px-3 py-2.5 text-[0.9375rem] font-semibold transition-colors duration-150 ${
              selected
                ? "bg-card text-brand shadow-sm ring-1 ring-border"
                : "text-muted hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** Compact process steps for “how this works” strips. */
export function StepList({
  steps,
}: {
  steps: { title: string; detail?: string }[];
}) {
  return (
    <ol className="grid gap-2 sm:grid-cols-3">
      {steps.map((s, i) => (
        <li
          key={s.title}
          className="flex gap-3 rounded-xl border border-border/70 bg-card/80 px-3 py-2.5"
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand ring-1 ring-brand/15"
            aria-hidden="true"
          >
            {i + 1}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{s.title}</p>
            {s.detail ? (
              <p className="text-xs text-muted">{s.detail}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Divider({ label }: { label?: string }) {
  if (!label) {
    return <hr className="border-0 border-t border-border" />;
  }
  return (
    <div className="flex items-center gap-3" role="separator" aria-label={label}>
      <div className="h-px flex-1 bg-border" />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
