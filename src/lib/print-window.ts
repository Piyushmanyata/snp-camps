export const PRINT_WINDOW_CLOSED = "PRINT_WINDOW_CLOSED";

function kolkataTodayIso(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isPrintWindowOpen(input: {
  dayDate: string | null | undefined;
  printingOpen: boolean;
  now?: Date;
}): boolean {
  if (!input.printingOpen || !input.dayDate) return false;
  return input.dayDate === kolkataTodayIso(input.now ?? new Date());
}

export function deskPrintWindowOpen(
  days: ReadonlyArray<{
    day_date?: string | null;
    printing_open?: boolean;
  }>,
  now?: Date,
): boolean {
  return days.some((day) =>
    isPrintWindowOpen({
      dayDate: day.day_date,
      printingOpen: day.printing_open === true,
      now,
    }),
  );
}
