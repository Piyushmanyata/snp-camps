"use client";

import {
  useCallback,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { SectionLoadError } from "@/components/section-load-error";
import { fetchDeskSection } from "@/lib/section-client";
import type { SectionKey } from "@/lib/section-reads";
import { Card, SectionTitle, Spinner, Stat } from "@/components/ui";

type SectionState<T> =
  | { status: "data"; data: T; staleError?: string }
  | { status: "error"; error: string }
  | { status: "loading" };

export function SectionDataIsland<T>({
  section,
  campId,
  initial,
  children,
}: {
  section: SectionKey;
  campId?: string | null;
  initial: { ok: true; data: T } | { ok: false; error: string };
  children: (
    data: T,
    controls: { refresh: () => void; pending: boolean },
  ) => ReactNode;
}) {
  const [state, setState] = useState<SectionState<T>>(() =>
    initial.ok
      ? { status: "data", data: initial.data }
      : { status: "error", error: initial.error },
  );
  const [pending, startTransition] = useTransition();

  const refresh = useCallback(() => {
    startTransition(async () => {
      setState((prev) =>
        prev.status === "error" ? { status: "loading" } : prev,
      );
      const result = await fetchDeskSection<T>(section, { campId });
      if (result.ok) {
        setState({ status: "data", data: result.data });
        return;
      }
      setState((prev) => {
        // Preserve already-loaded content on soft refresh failure (#63).
        if (prev.status === "data") {
          return { ...prev, staleError: result.error };
        }
        return { status: "error", error: result.error };
      });
    });
  }, [campId, section]);

  if (state.status === "loading" || (pending && state.status === "error")) {
    return (
      <p role="status" className="py-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Spinner className="h-3.5 w-3.5" />
          Loading…
        </span>
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <SectionLoadError message={state.error} onRetry={() => refresh()} />
    );
  }

  return (
    <>
      {state.staleError ? (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-sm"
        >
          <span>Showing earlier data. {state.staleError}</span>
          <button
            type="button"
            className="min-h-12 rounded-lg px-3 font-semibold text-brand"
            onClick={refresh}
            disabled={pending}
          >
            Retry
          </button>
        </div>
      ) : null}
      {children(state.data, { refresh, pending })}
    </>
  );
}

export function VolunteerKpisSection({
  campId,
  initial,
}: {
  campId: string;
  initial:
    | {
        ok: true;
        data: {
          total: number;
          today: number;
          seen: number;
        };
      }
    | { ok: false; error: string };
}) {
  return (
    <SectionDataIsland
      section="volunteer-kpis"
      campId={campId}
      initial={initial}
    >
      {(data) => (
        <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-2">
          <Stat label="Registered" value={data.total} tone="ok" />
          <Stat label="Seen" value={data.seen} tone="ok" />
        </div>
      )}
    </SectionDataIsland>
  );
}

function percent(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function FunnelRow({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  const pct = percent(value, total);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular text-muted">
          {value} · {pct}%
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-border/80"
        role="progressbar"
        aria-label={`${label}: ${pct}%`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function AdminAnalyticsPanel({
  campId,
  initial,
}: {
  campId: string | null;
  initial:
    | {
        ok: true;
        data: {
          registered: number;
          seen: number;
          total: number;
          completedToday: number;
          deskRegistrations: number;
          selfRegistrations: number;
          scannedRegistrations: number;
          selfDeclaredRegistrations: number;
        };
      }
    | { ok: false; error: string }
    | null;
}) {
  if (!campId || !initial) {
    return (
      <Card>
        <SectionTitle>Active-camp analytics</SectionTitle>
        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          <Stat label="Registered" value={0} />
          <Stat label="Seen" value={0} tone="ok" />
        </div>
        <p className="mt-3 text-sm text-muted">
          No active camp. Activate a camp to see operational analytics.
        </p>
      </Card>
    );
  }

  return (
    <SectionDataIsland
      section="admin-analytics"
      campId={campId}
      initial={initial}
    >
      {(data, controls) => (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <SectionTitle hint="Active camp · Asia/Kolkata">
              Operational analytics
            </SectionTitle>
            <button
              type="button"
              onClick={controls.refresh}
              disabled={controls.pending}
              className="pressable min-h-12 rounded-lg px-3 text-sm font-semibold text-brand hover:bg-brand-soft disabled:opacity-50"
              aria-busy={controls.pending}
            >
              {controls.pending ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {data.total === 0 ? (
            <p className="rounded-xl border border-border bg-background/50 p-3 text-sm text-muted">
              No registrations in this camp yet.
            </p>
          ) : null}
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div className="space-y-2.5">
              <p className="text-xs font-bold uppercase tracking-wide text-muted">
                Lifecycle
              </p>
              <FunnelRow label="Registered" value={data.registered} total={data.total} />
              <FunnelRow label="Seen" value={data.seen} total={data.total} />
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-muted">
                Throughput
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-2">
                {[
                  ["Seen today", String(data.completedToday)],
                  ["Seen in camp", String(data.seen)],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-xl border border-border bg-background/50 p-3"
                  >
                    <dt className="text-xs text-muted">{label}</dt>
                    <dd className="tabular mt-0.5 text-lg font-bold text-foreground">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
          <div className="mt-4 border-t border-border pt-4">
            <p className="text-xs font-bold uppercase tracking-wide text-muted">
              Registration source mix
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <FunnelRow
                label="Desk registration"
                value={data.deskRegistrations}
                total={data.total}
              />
              <FunnelRow
                label="Self registration"
                value={data.selfRegistrations}
                total={data.total}
              />
              <FunnelRow
                label="Card scanned"
                value={data.scannedRegistrations}
                total={data.total}
              />
              <FunnelRow
                label="Self-declared details"
                value={data.selfDeclaredRegistrations}
                total={data.total}
              />
            </div>
          </div>
        </Card>
      )}
    </SectionDataIsland>
  );
}

export function CampsLoadFailed({
  message,
  title = "Camps",
  retryLabel = "Reload",
}: {
  message: string;
  title?: string;
  retryLabel?: string;
}) {
  return (
    <Card>
      <SectionTitle>{title}</SectionTitle>
      <SectionLoadError
        message={message}
        onRetry={() => {
          window.location.reload();
        }}
        retryLabel={retryLabel}
      />
    </Card>
  );
}

