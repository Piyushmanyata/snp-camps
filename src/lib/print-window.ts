import { kolkataTodayIso } from "@/lib/patient-form-validate";

export const PRINT_WINDOW_CLOSED = "PRINT_WINDOW_CLOSED";

export function printConfirmationGate(input: {
  clientMissing: boolean;
  queryError: boolean;
  gate: {
    provenance?: string | null;
    confirmation_override_at?: string | null;
    duplicateKey?: string | null;
  } | null;
}): "unavailable" | "required" | "ok" {
  if (
    input.clientMissing ||
    input.queryError ||
    !input.gate ||
    !input.gate.provenance
  ) {
    return "unavailable";
  }
  if (
    input.gate.provenance === "manual_exception" &&
    !input.gate.confirmation_override_at &&
    !input.gate.duplicateKey
  ) {
    return "required";
  }
  return "ok";
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
