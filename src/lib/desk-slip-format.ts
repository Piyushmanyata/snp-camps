/** Desk slip printer format — station setting, not auto-detected. */

export const DESK_SLIP_FORMATS = ["a4", "thermal58"] as const;
export type DeskSlipFormat = (typeof DESK_SLIP_FORMATS)[number];

export const DESK_SLIP_FORMAT_DEFAULT: DeskSlipFormat = "a4";
export const DESK_SLIP_FORMAT_STORAGE_KEY = "snp.deskSlipFormat";

const listeners = new Set<() => void>();

export function isDeskSlipFormat(value: unknown): value is DeskSlipFormat {
  return value === "a4" || value === "thermal58";
}

/** Parse URL/query/storage input; unknown → default. */
export function parseDeskSlipFormat(
  raw: string | null | undefined,
): DeskSlipFormat {
  if (raw == null) return DESK_SLIP_FORMAT_DEFAULT;
  const v = raw.trim().toLowerCase();
  return isDeskSlipFormat(v) ? v : DESK_SLIP_FORMAT_DEFAULT;
}

export function readDeskSlipFormatFromStorage(): DeskSlipFormat {
  if (typeof window === "undefined") return DESK_SLIP_FORMAT_DEFAULT;
  try {
    return parseDeskSlipFormat(
      window.localStorage.getItem(DESK_SLIP_FORMAT_STORAGE_KEY),
    );
  } catch {
    return DESK_SLIP_FORMAT_DEFAULT;
  }
}

export function writeDeskSlipFormatToStorage(format: DeskSlipFormat): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DESK_SLIP_FORMAT_STORAGE_KEY, format);
  } catch {
    // private mode / quota — in-memory listeners still update this tab
  }
  for (const listener of listeners) listener();
}

/** useSyncExternalStore subscribe — same-tab writes + cross-tab storage events. */
export function subscribeDeskSlipFormat(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStoreChange);
  }
  return () => {
    listeners.delete(onStoreChange);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStoreChange);
    }
  };
}

export function getDeskSlipFormatServerSnapshot(): DeskSlipFormat {
  return DESK_SLIP_FORMAT_DEFAULT;
}

export function deskSlipFormatLabel(format: DeskSlipFormat): string {
  return format === "thermal58" ? "58mm thermal" : "A4 multi-up";
}
