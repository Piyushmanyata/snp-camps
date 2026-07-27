/**
 * Narrow section read seams (#63).
 * Each loader returns a safe result — never throws for expected query failures.
 * Client retry hits one section only via /api/desk/section.
 */

import {
  DOCTOR_LIST_UNAVAILABLE,
  getDoctorsList,
} from "@/lib/metadata";
import { mapDbError } from "@/lib/public-error";
import { createClient } from "@/lib/supabase/server";
import type { CampDayStats, DoctorOption } from "@/lib/types";

export type SectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type WaitingRow = {
  id: string;
  reg_no: number;
  full_name: string;
  phone: string | null;
  queued_at?: string | null;
};

export type QueueSectionData = {
  waiting: WaitingRow[];
  waitingTotal: number;
};

export type SeatsSectionData = {
  days: CampDayStats[];
};

export type KpisSectionData = {
  total: number;
  today: number;
  waiting: number;
  seen: number;
};

export type DoctorStatsData = {
  seenToday: number;
  seenTotal: number;
};

export type DoctorSeenRow = {
  id: string;
  reg_no: number;
  full_name: string;
  seen_at: string | null;
};

export type AdminQueueCountsData = {
  registered: number;
  inQueue: number;
  doctorSeen: number;
  avgWaitMinutes: number | null;
};

/** Pending counter work for patients already seen by a doctor (#106). */
export type AwaitingTreatmentData = {
  ot: number;
  pharmacy: number;
  spectacles: number;
};

export const SECTION_KEYS = [
  "queue",
  "seats",
  "volunteer-kpis",
  "doctors",
  "doctor-stats",
  "doctor-seen",
  "admin-queue-counts",
  "awaiting-treatment",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export function isSectionKey(value: string): value is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(value);
}

function kolkataStartOfDayIso(): string {
  const kolkataDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return new Date(kolkataDate + "T00:00:00+05:30").toISOString();
}

export async function loadQueueSection(
  campId: string,
): Promise<SectionResult<QueueSectionData>> {
  const supabase = await createClient();
  const { data, error, count } = await supabase
    .from("patients")
    .select("id, reg_no, full_name, phone, queued_at", { count: "exact" })
    .eq("camp_id", campId)
    .eq("queue_status", "waiting")
    .order("queued_at", { ascending: true, nullsFirst: false })
    .limit(100);

  if (error) {
    return {
      ok: false,
      error: mapDbError(error, {
        context: "section.queue",
        fallback: "Queue could not be loaded — retry.",
      }),
    };
  }

  const waiting = (data || []) as WaitingRow[];
  return {
    ok: true,
    data: {
      waiting,
      waitingTotal: count ?? waiting.length,
    },
  };
}

export async function loadSeatsSection(
  campId: string,
): Promise<SectionResult<SeatsSectionData>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("camp_day_stats", {
    p_camp_id: campId,
  });

  if (error) {
    return {
      ok: false,
      error: mapDbError(error, {
        context: "section.seats",
        fallback: "Seat board could not be loaded — retry.",
      }),
    };
  }

  return {
    ok: true,
    data: { days: (data as CampDayStats[]) || [] },
  };
}

export async function loadVolunteerKpisSection(
  campId: string,
  userId: string,
): Promise<SectionResult<KpisSectionData>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_person_kpis", {
    p_user_id: userId,
    p_role: "volunteer",
    p_camp_id: campId,
    p_since: kolkataStartOfDayIso(),
  });

  if (error) {
    return {
      ok: false,
      error: mapDbError(error, {
        context: "section.volunteer-kpis",
        fallback: "Your stats could not be loaded — retry.",
      }),
    };
  }

  const row = data?.[0];
  return {
    ok: true,
    data: {
      total: Number(row?.total ?? 0),
      today: Number(row?.today ?? 0),
      waiting: Number(row?.waiting ?? 0),
      seen: Number(row?.seen ?? 0),
    },
  };
}

export type StaffKpiRow = {
  staff_id: string;
  full_name: string;
  role: string;
  distinct_patients: number;
  team_lead_id: string | null;
  team_headcount: number;
};

/**
 * Whole-camp staff rollup for the Team Lead panel (#119/#121).
 * Note the two `staff_person_kpis` overloads: this is the (camp, staff) one,
 * not the per-volunteer (user, role, camp, since) one above.
 */
export async function loadStaffLeaderboardSection(
  campId: string,
): Promise<SectionResult<StaffKpiRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_person_kpis", {
    p_camp_id: campId,
    p_target_staff_id: null,
  });

  if (error) {
    return {
      ok: false,
      error: mapDbError(error, {
        context: "section.staff-leaderboard",
        fallback: "Team stats could not be loaded — retry.",
      }),
    };
  }

  return {
    ok: true,
    data: ((data ?? []) as StaffKpiRow[]).map((row) => ({
      staff_id: row.staff_id,
      full_name: row.full_name,
      role: row.role,
      distinct_patients: Number(row.distinct_patients ?? 0),
      team_lead_id: row.team_lead_id ?? null,
      team_headcount: Number(row.team_headcount ?? 0),
    })),
  };
}

export async function loadDoctorsSection(): Promise<
  SectionResult<DoctorOption[]>
> {
  try {
    const list = await getDoctorsList();
    return { ok: true, data: list };
  } catch (err) {
    return {
      ok: false,
      error: mapDbError(err, {
        context: "section.doctors",
        fallback: DOCTOR_LIST_UNAVAILABLE,
      }),
    };
  }
}

export async function loadDoctorStatsSection(
  campId: string,
): Promise<SectionResult<DoctorStatsData>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("doctor_my_counts", {
    p_camp_id: campId,
    p_since: kolkataStartOfDayIso(),
  });

  if (error) {
    return {
      ok: false,
      error: mapDbError(error, {
        context: "section.doctor-stats",
        fallback: "Your stats could not be loaded — retry.",
      }),
    };
  }

  return {
    ok: true,
    data: {
      seenToday: Number(data?.[0]?.seen_today ?? 0),
      seenTotal: Number(data?.[0]?.seen_total ?? 0),
    },
  };
}

export async function loadDoctorSeenSection(
  campId: string,
): Promise<SectionResult<DoctorSeenRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("doctor_recent_patients", {
    p_camp_id: campId,
    p_limit: 50,
  });

  if (error) {
    return {
      ok: false,
      error: mapDbError(error, {
        context: "section.doctor-seen",
        fallback: "Patients you saw could not be loaded — retry.",
      }),
    };
  }

  return {
    ok: true,
    data: (data || []) as DoctorSeenRow[],
  };
}

export async function loadAdminQueueCountsSection(
  campId: string,
): Promise<SectionResult<AdminQueueCountsData>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("camp_queue_counts", {
    p_camp_id: campId,
  });

  if (error) {
    return {
      ok: false,
      error: mapDbError(error, {
        context: "section.admin-queue-counts",
        fallback: "Dashboard stats could not be loaded — retry.",
      }),
    };
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<
    string,
    unknown
  > | null;
  const avgRaw = row?.avg_wait_minutes;
  const avgWaitMinutes =
    avgRaw != null && !Number.isNaN(Number(avgRaw)) ? Number(avgRaw) : null;

  return {
    ok: true,
    data: {
      registered: Number(row?.registered_count ?? 0),
      inQueue: Number(row?.waiting_count ?? 0),
      doctorSeen: Number(row?.seen_count ?? 0),
      avgWaitMinutes,
    },
  };
}

/**
 * Count distinct seen patients with at least one pending order per station
 * in the active camp. Derived only — no fourth queue_status (#106 / ADR 0007).
 */
export async function loadAwaitingTreatmentSection(
  campId: string,
): Promise<SectionResult<AwaitingTreatmentData>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("treatment_orders")
    .select(
      `
      kind,
      patient_id,
      patients!inner (
        id,
        queue_status,
        camp_id
      )
    `,
    )
    .eq("camp_id", campId)
    .eq("status", "pending")
    .eq("patients.queue_status", "seen")
    .eq("patients.camp_id", campId);

  if (error) {
    return {
      ok: false,
      error: mapDbError(error, {
        context: "section.awaiting-treatment",
        fallback: "Awaiting treatment counts could not be loaded — retry.",
      }),
    };
  }

  const sets = {
    ot: new Set<string>(),
    pharmacy: new Set<string>(),
    spectacles: new Set<string>(),
  };

  for (const row of data || []) {
    const kind = (row as { kind?: string }).kind;
    const patientId = (row as { patient_id?: string }).patient_id;
    if (!patientId) continue;
    if (kind === "ot" || kind === "pharmacy" || kind === "spectacles") {
      sets[kind].add(patientId);
    }
  }

  return {
    ok: true,
    data: {
      ot: sets.ot.size,
      pharmacy: sets.pharmacy.size,
      spectacles: sets.spectacles.size,
    },
  };
}

/** Dispatch one narrow section read — used by the section API and tests. */
export async function loadSection(
  section: SectionKey,
  params: { campId?: string | null; userId?: string | null },
): Promise<SectionResult<unknown>> {
  const campId = params.campId ?? null;
  const userId = params.userId ?? null;

  switch (section) {
    case "queue":
      if (!campId) return { ok: false, error: "Camp required." };
      return loadQueueSection(campId);
    case "seats":
      if (!campId) return { ok: false, error: "Camp required." };
      return loadSeatsSection(campId);
    case "volunteer-kpis":
      if (!campId || !userId) {
        return { ok: false, error: "Camp and user required." };
      }
      return loadVolunteerKpisSection(campId, userId);
    case "doctors":
      return loadDoctorsSection();
    case "doctor-stats":
      if (!campId) return { ok: false, error: "Camp required." };
      return loadDoctorStatsSection(campId);
    case "doctor-seen":
      if (!campId) return { ok: false, error: "Camp required." };
      return loadDoctorSeenSection(campId);
    case "admin-queue-counts":
      if (!campId) return { ok: false, error: "Camp required." };
      return loadAdminQueueCountsSection(campId);
    case "awaiting-treatment":
      if (!campId) return { ok: false, error: "Camp required." };
      return loadAwaitingTreatmentSection(campId);
    default: {
      const _exhaustive: never = section;
      return { ok: false, error: `Unknown section: ${_exhaustive}` };
    }
  }
}
