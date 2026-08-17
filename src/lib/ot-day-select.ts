export type OtScheduleDay = {
  id: string;
  dayDate: string;
  seatLimit: number;
  seatsTaken: number;
};

export function needsOtScheduleDay(
  kind: string,
  outcome: string,
  otDayId: string | null | undefined,
): boolean {
  return kind === "ot" && outcome === "deferred" && !otDayId;
}

export function pickEarliestFreeOtDay(
  days: readonly OtScheduleDay[],
): OtScheduleDay | null {
  const open = days
    .filter((day) => day.seatsTaken < day.seatLimit)
    .slice()
    .sort((a, b) => {
      if (a.dayDate !== b.dayDate) return a.dayDate < b.dayDate ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  return open[0] ?? null;
}
