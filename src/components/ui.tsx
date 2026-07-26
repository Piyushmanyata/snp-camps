import Link from "next/link";
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
} from "react";

const shellWidths = {
  sm: "max-w-lg",
  md: "max-w-2xl",
  lg: "max-w-4xl",
  xl: "max-w-6xl",
} as const;

type DockItem = {
  href: string;
  label: string;
  /** Primary CTA gets solid brand fill */
  primary?: boolean;
};

/** Sticky bottom action bar for field desk pages (mobile only). */
function MobileDock({
  items,
  label = "Quick actions",
}: {
  items: DockItem[];
  label?: string;
}) {
  if (!items.length) return null;
  const cols = Math.min(Math.max(items.length, 1), 4);
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
            className={`pressable mobile-dock-item inline-flex items-center justify-center rounded-xl px-1.5 text-center text-[0.8125rem] font-bold leading-tight transition-colors duration-150 sm:text-sm ${
 item.primary
 ? "bg-brand text-white hover:bg-brand-dark"
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
        className={`mx-auto flex w-full flex-1 flex-col px-3.5 pt-3 sm:px-6 sm:pt-6 lg:px-8 ${shellWidths[width]} ${
 hasDock ? "has-mobile-dock" : "pb-8 sm:pb-10"
 }`}
        style={{
          paddingTop: "calc(0.75rem + var(--safe-top))",
          ...(hasDock
            ? {}
            : { paddingBottom: "calc(2rem + var(--safe-bottom))" }),
        }}
      >
        <header className="mb-4 flex items-start gap-2.5 rounded-2xl border border-border bg-card p-3.5 sm:mb-6 sm:gap-3 sm:p-4">
          {backHref ? (
            <Link
              href={backHref}
              className="pressable mt-0.5 inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground hover:border-brand/30 hover:bg-brand-soft"
              aria-label="Go back"
            >
              <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 4L6 8l4 4" />
              </svg>
            </Link>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <p className="text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-brand sm:text-xs">
                SNP Camps
              </p>
              {roleLabel ? (
                <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand ring-1 ring-brand/15 sm:px-2.5 sm:text-[11px]">
                  {roleLabel}
                </span>
              ) : null}
            </div>
            <h1 className="mt-0.5 text-[1.5rem] font-bold leading-tight tracking-tight text-foreground sm:text-[1.9rem]">
              {title}
            </h1>
            {subtitle ? (
              <p className="prose-help mt-0.5 text-[0.875rem] text-muted sm:mt-1 sm:text-[0.9375rem]">
                {subtitle}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-start gap-2">{actions}</div>
          ) : null}
        </header>
        <main id="main" className="flex flex-1 flex-col gap-0">
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
      className={`min-w-0 rounded-xl border border-border bg-card sm:rounded-2xl ${p} ${className}`}
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
    <div className="mb-3 flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-end sm:justify-between sm:gap-2">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        {children}
      </h2>
      {hint ? (
        <span className="text-[0.8125rem] text-muted sm:text-right">{hint}</span>
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
      className="group rounded-2xl border border-border bg-card"
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {hint ? (
            <span className="text-[0.8125rem] text-muted">{hint}</span>
          ) : null}
          <span
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-background text-muted transition-transform duration-150 group-open:rotate-180"
            aria-hidden="true"
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6l4 4 4-4" />
            </svg>
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
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  const sizes =
    size === "sm"
      ? "min-h-12 px-3.5 text-[0.9375rem]"
      : size === "lg"
        ? "min-h-16 px-5 text-[1.2rem] font-bold"
        : "min-h-[3.25rem] px-4 text-[1.0625rem]";
  const styles =
    variant === "primary"
      ? "bg-brand text-white hover:bg-brand-dark"
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
      className={`pressable inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-brand/40 ${sizes} ${styles} ${className}`}
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
  const uniqueId = useId();
  const inputId = id || `field-${uniqueId}`;
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
        className={`min-h-[3.25rem] w-full rounded-xl border bg-card px-3.5 text-[1.0625rem] text-foreground outline-none transition-[border-color] duration-150 placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:bg-background disabled:opacity-70 ${
 error
 ? "border-danger focus:border-danger focus:ring-danger/20"
 : "border-border"
 } ${className}`}
        {...props}
      />
      {error ? (
        <span
          id={errorId}
          role="alert"
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
  const uniqueId = useId();
  const selectId = id || `select-${uniqueId}`;
  const hintId = hint ? `${selectId}-hint` : undefined;

  return (
    <label className="block space-y-1.5" htmlFor={selectId}>
      <span className="text-[0.9375rem] font-semibold text-foreground/90">
        {label}
      </span>
      <select
        id={selectId}
        aria-describedby={hintId}
        className="min-h-[3.25rem] w-full cursor-pointer rounded-xl border border-border bg-card px-3.5 text-[1.0625rem] text-foreground outline-none transition-[border-color] duration-150 focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-70"
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
      className="rounded-xl border border-amber-200 bg-warning-soft px-3.5 py-3 text-[0.9375rem] font-medium text-amber-950"
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
  tone?: "default" | "ok" | "wait" | "danger";
}) {
  const c =
    tone === "ok"
      ? "bg-emerald-500/10 text-emerald-700 ring-1 ring-emerald-500/30"
      : tone === "wait"
        ? "bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/30"
        : tone === "danger"
          ? "bg-danger-soft text-danger ring-1 ring-danger/25"
          : "bg-background text-muted ring-1 ring-border/80";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.8125rem] font-semibold transition-all duration-150 ${c}`}
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
    <div className="rounded-xl border border-border bg-card px-2 py-2.5 text-center sm:rounded-2xl sm:p-3.5">
      <p
        className={`tabular text-[1.5rem] font-bold tracking-tight sm:text-[1.85rem] ${accent}`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[0.75rem] font-semibold uppercase leading-tight tracking-wide text-muted sm:text-[0.8125rem]">
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
      ? "bg-brand text-white hover:bg-brand-dark"
      : variant === "soft"
        ? "border border-border bg-brand-soft font-semibold text-brand hover:bg-white hover:border-brand/30"
        : "border border-border bg-card font-semibold text-foreground hover:bg-brand-soft";
  return (
    <Link
      href={href}
      className={`pressable inline-flex min-h-[3.25rem] w-full cursor-pointer items-center justify-center rounded-xl px-4 text-[1.0625rem] font-semibold transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-brand/40 ${styles}`}
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
        className="flex min-h-[5rem] flex-col items-center justify-center rounded-2xl border border-border bg-card/60 px-4 py-4 text-center opacity-60 sm:items-start sm:text-left"
        aria-disabled="true"
      >
        <span className="text-xl font-bold text-muted">{title}</span>
        <span className="mt-0.5 text-[0.8125rem] font-medium text-muted">
          {disabledReason || description}
        </span>
      </div>
    );
  }

  const styles =
    variant === "primary"
      ? "bg-brand text-white hover:bg-brand-dark"
      : variant === "soft"
        ? "border border-brand/20 bg-brand-soft text-brand hover:bg-white hover:border-brand/35"
        : "border border-border bg-card text-foreground hover:border-brand/30 hover:bg-brand-soft";

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

export function EmptyState({
  children,
  title,
  action,
}: {
  children: ReactNode;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/90 bg-background/60 px-4 py-8 text-center">
      <div
        className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card text-muted"
        aria-hidden="true"
      >
        <svg
          className="h-5 w-5 opacity-70"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="1.75"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
          />
        </svg>
      </div>
      {title ? (
        <p className="text-base font-semibold text-foreground">{title}</p>
      ) : null}
      <p className="max-w-xs text-sm text-muted">{children}</p>
      {action ? <div className="mt-3">{action}</div> : null}
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
      role="radiogroup"
      aria-orientation="horizontal"
      aria-label={label || "Options"}
      className="grid gap-1 rounded-xl border border-border bg-background p-1"
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      {options.map((opt, index) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(event) => {
              const keys = [
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                "Home",
                "End",
              ];
              if (!keys.includes(event.key)) return;
              event.preventDefault();

              const nextIndex =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? options.length - 1
                    : event.key === "ArrowLeft" || event.key === "ArrowUp"
                      ? (index - 1 + options.length) % options.length
                      : (index + 1) % options.length;
              const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                '[role="radio"]',
              );
              buttons?.[nextIndex]?.focus();
              onChange(options[nextIndex]!.value);
            }}
            className={`pressable min-h-12 cursor-pointer rounded-lg px-3 py-2.5 text-[0.9375rem] font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
 selected
 ? "bg-card text-brand ring-1 ring-border"
 : "text-muted hover:text-foreground hover:bg-card/60"
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
          className="flex gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white"
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
