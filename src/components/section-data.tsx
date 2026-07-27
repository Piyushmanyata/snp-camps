"use client";

import {
  useCallback,
  useEffect,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import Link from "next/link";
import { SectionLoadError } from "@/components/section-load-error";
import { fetchDeskSection } from "@/lib/section-client";
import type {
  AwaitingTreatmentData,
  SectionKey,
} from "@/lib/section-reads";
import {
  Card,
  CollapsibleSection,
  EmptyState,
  SectionTitle,
  Spinner,
  Stat,
} from "@/components/ui";

type SectionState<T> =
  | { status: "data"; data: T }
  | { status: "error"; error: string }
  | { status: "loading" };

/**
 * Recoverable client island for one narrow section (#63).
 * Initial SSR result seeds state; Retry calls only that section endpoint.
 * Soft refresh failure preserves prior data when present.
 */
export function SectionDataIsland<T>({
  section,
  campId,
  initial,
  children,
}: {
  section: SectionKey;
  campId?: string | null;
  initial: { ok: true; data: T } | { ok: false; error: string };
  children: (data: T, controls: { refresh: () => void }) => ReactNode;
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
        if (prev.status === "data") return prev;
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

  return <>{children(state.data, { refresh })}</>;
}

/** Volunteer KPI strip with isolated retry. */
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
          waiting: number;
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
        <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="You handled" value={data.total} tone="ok" />
          <Stat label="Handled today" value={data.today} />
          <Stat label="In queue" value={data.waiting} tone="wait" />
          <Stat label="Doctor seen" value={data.seen} tone="ok" />
        </div>
      )}
    </SectionDataIsland>
  );
}

/** Doctor today/total stats with isolated retry. */
export function DoctorStatsPanel({
  campId,
  initial,
}: {
  campId: string;
  initial:
    | { ok: true; data: { seenToday: number; seenTotal: number } }
    | { ok: false; error: string };
}) {
  return (
    <SectionDataIsland section="doctor-stats" campId={campId} initial={initial}>
      {(data) => (
        <div className="grid w-full grid-cols-2 gap-2">
          <Stat label="You saw today" value={data.seenToday} tone="ok" />
          <Stat label="Total seen" value={data.seenTotal} />
        </div>
      )}
    </SectionDataIsland>
  );
}

/** Doctor "patients you saw" list with isolated retry. */
export function DoctorSeenPanel({
  campId,
  initial,
}: {
  campId: string;
  initial:
    | {
        ok: true;
        data: {
          id: string;
          reg_no: number;
          full_name: string;
          seen_at: string | null;
        }[];
      }
    | { ok: false; error: string };
}) {
  return (
    <div id="seen">
      <SectionDataIsland
        section="doctor-seen"
        campId={campId}
        initial={initial}
      >
        {(mySeen) => (
          <CollapsibleSection
            title="Patients you saw"
            hint={`${mySeen.length} recent`}
            defaultOpen={false}
          >
            {mySeen.length ? (
              <ul className="divide-y divide-border">
                {mySeen.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        <span className="tabular text-brand">#{p.reg_no}</span>{" "}
                        {p.full_name}
                      </p>
                      <p className="text-xs text-muted">
                        {p.seen_at
                          ? new Date(p.seen_at).toLocaleString("en-IN", {
                              hour: "2-digit",
                              minute: "2-digit",
                              day: "numeric",
                              month: "short",
                            })
                          : "—"}
                      </p>
                    </div>
                    <Link
                      href={`/print/prescription/${p.id}`}
                      className="pressable inline-flex min-h-12 shrink-0 items-center rounded-lg border border-brand/25 bg-brand-soft px-3 py-2 text-sm font-semibold text-brand hover:bg-white"
                      data-testid="print-prescription"
                    >
                      Print prescription
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>
                No patients assigned to you yet. Scan a registered patient or
                enter their reg number when they arrive.
              </EmptyState>
            )}
          </CollapsibleSection>
        )}
      </SectionDataIsland>
    </div>
  );
}

const AWAITING_POLL_MS = 20_000;

const AWAITING_STATIONS: {
  kind: keyof AwaitingTreatmentData;
  label: string;
  href: string;
}[] = [
  { kind: "ot", label: "OT", href: "/counter?station=ot" },
  {
    kind: "pharmacy",
    label: "Medicines",
    href: "/counter?station=pharmacy",
  },
  {
    kind: "spectacles",
    label: "Spectacles",
    href: "/counter?station=spectacles",
  },
];

/**
 * Awaiting treatment card (#106) — derived counts of seen patients with
 * pending orders, polled (no realtime on patient rows).
 */
export function AwaitingTreatmentCard({
  campId,
  initial,
}: {
  campId: string | null;
  initial:
    | { ok: true; data: AwaitingTreatmentData }
    | { ok: false; error: string }
    | null;
}) {
  if (!campId) {
    return (
      <Card className="!p-4 sm:!p-5" data-testid="awaiting-treatment-card">
        <SectionTitle hint="After the doctor">Awaiting treatment</SectionTitle>
        <p className="text-sm text-muted" role="status">
          No active camp — these counts stay at zero until an admin activates
          one.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {AWAITING_STATIONS.map((s) => (
            <div
              key={s.kind}
              className="rounded-xl border border-border bg-background/50 px-2 py-3 text-center"
            >
              <p className="text-xs font-semibold text-muted">{s.label}</p>
              <p className="mt-0.5 text-xl font-bold tabular">0</p>
            </div>
          ))}
        </div>
      </Card>
    );
  }

  if (!initial) {
    return null;
  }

  return (
    <Card className="!p-4 sm:!p-5" data-testid="awaiting-treatment-card">
      <SectionTitle hint="Seen · pending orders">Awaiting treatment</SectionTitle>
      <SectionDataIsland
        section="awaiting-treatment"
        campId={campId}
        initial={initial}
      >
        {(data, { refresh }) => (
          <AwaitingTreatmentBody data={data} refresh={refresh} />
        )}
      </SectionDataIsland>
    </Card>
  );
}

function AwaitingTreatmentBody({
  data,
  refresh,
}: {
  data: AwaitingTreatmentData;
  refresh: () => void;
}) {
  useEffect(() => {
    const id = window.setInterval(() => {
      refresh();
    }, AWAITING_POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  return (
    <div className="mt-1 grid grid-cols-3 gap-2">
      {AWAITING_STATIONS.map((s) => (
        <Link
          key={s.kind}
          href={s.href}
          className="pressable rounded-xl border border-border bg-background/50 px-2 py-3 text-center transition-colors hover:border-brand/40 hover:bg-brand-soft/40"
          data-testid={`awaiting-${s.kind}`}
        >
          <p className="text-xs font-semibold text-muted">{s.label}</p>
          <p className="mt-0.5 text-xl font-bold tabular text-brand">
            {data[s.kind]}
          </p>
        </Link>
      ))}
    </div>
  );
}

/** Admin header KPI strip with isolated retry. */
export function AdminHeaderStatsPanel({
  campId,
  initial,
}: {
  campId: string | null;
  initial:
    | {
        ok: true;
        data: {
          registered: number;
          inQueue: number;
          doctorSeen: number;
          avgWaitMinutes: number | null;
        };
      }
    | { ok: false; error: string }
    | null;
}) {
  if (!campId || !initial) {
    return (
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <Stat label="Registered" value={0} />
        <Stat label="In queue" value={0} tone="wait" />
        <Stat label="Doctor seen" value={0} tone="ok" />
      </div>
    );
  }

  return (
    <SectionDataIsland
      section="admin-queue-counts"
      campId={campId}
      initial={initial}
    >
      {(data) => (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <Stat label="Registered" value={data.registered} />
            <Stat label="In queue" value={data.inQueue} tone="wait" />
            <Stat label="Doctor seen" value={data.doctorSeen} tone="ok" />
          </div>
          {data.avgWaitMinutes != null ? (
            <p className="text-[0.8125rem] text-muted">
              Avg wait (queued → doctor seen):{" "}
              <span className="font-semibold tabular text-foreground">
                {data.avgWaitMinutes < 1
                  ? "< 1 min"
                  : `${Math.round(data.avgWaitMinutes)} min`}
              </span>
            </p>
          ) : null}
        </div>
      )}
    </SectionDataIsland>
  );
}

/**
 * Foundation section failed — reload is the last-resort seam when no
 * narrower client endpoint exists. Still isolated from the route error page.
 */
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


