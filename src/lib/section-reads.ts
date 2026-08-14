
import { mapDbError } from "@/lib/public-error";
import { createClient } from "@/lib/supabase/server";
import type { CampDayStats } from "@/lib/types";

export type SectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type SeatsSectionData = {
  days: CampDayStats[];
};

export type KpisSectionData = {
  total: number;
  today: number;
  seen: number;
};

export type AdminAnalyticsData = {
  registered: number;
  seen: number;
  total: number;
  completedToday: number;
  deskRegistrations: number;
  selfRegistrations: number;
  scannedRegistrations: number;
  selfDeclaredRegistrations: number;
};

export const SECTION_KEYS = [
  "seats",
  "volunteer-kpis",
  "admin-analytics",
  "staff-leaderboard",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export function isSectionKey(value: string): value is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(value);
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
  role: "volunteer" | "team_lead" = "volunteer",
): Promise<SectionResult<KpisSectionData>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_person_kpis", {
    p_user_id: userId,
    p_role: role,
    p_camp_id: campId,
    p_scope: "person",
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
      seen: Number(row?.seen ?? 0),
    },
  };
}

export type StaffKpiRow = {
  staff_id: string;
  full_name: string;
  role: string;
  distinct_patients: number;
  registered_count: number;
  seen_count: number;
  metric_label: string;
  total?: number | null;
  seen?: number | null;
  label?: string | null;
  team_lead_id: string | null;
  team_headcount: number;
};

export async function loadStaffLeaderboardSection(
  campId: string | null,
): Promise<SectionResult<StaffKpiRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_person_kpis", {
    p_user_id: null,
    p_role: null,
    p_camp_id: campId,
    p_scope: "leaderboard",
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
    data: (
      (data ?? []) as Array<StaffKpiRow & { staff_role?: string }>
    ).map((row) => ({
      staff_id: row.staff_id,
      full_name: row.full_name,
      role: row.staff_role ?? row.role,
      distinct_patients: Number(row.distinct_patients ?? 0),
      registered_count: Number(row.total ?? 0),
      seen_count: Number(row.seen ?? 0),
      metric_label: String(row.label ?? "Registered"),
      team_lead_id: row.team_lead_id ?? null,
      team_headcount: Number(row.team_headcount ?? 0),
    })),
  };
}

export async function loadAdminQueueCountsSection(
  campId: string,
): Promise<SectionResult<AdminAnalyticsData>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("camp_queue_counts", {
    p_camp_id: campId,
  });

  if (error) {
    return {
      ok: false,
      error: mapDbError(error, {
        context: "section.admin-analytics",
        fallback: "Dashboard stats could not be loaded — retry.",
      }),
    };
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<
    string,
    unknown
  > | null;

  return {
    ok: true,
    data: {
      registered: Number(row?.registered_count ?? 0),
      seen: Number(row?.seen_count ?? 0),
      total: Number(row?.total_count ?? 0),
      completedToday: Number(row?.completed_today_count ?? 0),
      deskRegistrations: Number(row?.desk_registration_count ?? 0),
      selfRegistrations: Number(row?.self_registration_count ?? 0),
      scannedRegistrations: Number(row?.scanned_registration_count ?? 0),
      selfDeclaredRegistrations: Number(row?.self_declared_count ?? 0),
    },
  };
}

export async function loadSection(
  section: SectionKey,
  params: {
    campId?: string | null;
    userId?: string | null;
    kpiRole?: "volunteer" | "team_lead";
  },
): Promise<SectionResult<unknown>> {
  const campId = params.campId ?? null;
  const userId = params.userId ?? null;

  switch (section) {
    case "seats":
      if (!campId) return { ok: false, error: "Camp required." };
      return loadSeatsSection(campId);
    case "volunteer-kpis":
      if (!campId || !userId) {
        return { ok: false, error: "Camp and user required." };
      }
      return loadVolunteerKpisSection(
        campId,
        userId,
        params.kpiRole ?? "volunteer",
      );
    case "admin-analytics":
      if (!campId) return { ok: false, error: "Camp required." };
      return loadAdminQueueCountsSection(campId);
    case "staff-leaderboard":
      return loadStaffLeaderboardSection(campId);
    default: {
      const _exhaustive: never = section;
      return { ok: false, error: `Unknown section: ${_exhaustive}` };
    }
  }
}
