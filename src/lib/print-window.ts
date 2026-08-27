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
  printingOpen: boolean;
}): boolean {
  return input.printingOpen === true;
}

export function deskPrintWindowOpen(
  days: ReadonlyArray<{
    day_date?: string | null;
    printing_open?: boolean;
  }>,
): boolean {
  return days.some((day) => day.printing_open === true);
}
