
export type RetryDelays = {
  extraAttempts?: number;
  delaysMs?: number[];
};

/** Volunteer-facing copy after automatic retries are exhausted (#47 / #32 / #61). */
export const RETRY_EXHAUSTED_COPY = {
  register: "Could not save. Check your connection and click Try Again.",
  lookup:
    "Could not look up patient. Check your connection and click Try Again.",
  markSeen:
    "Could not mark as seen. Check your connection and click Try Again.",
  undo:
    "Could not undo seen status. Check your connection and click Try Again.",
  changeDay:
    "Could not change camp day. Check your connection and click Try Again.",
  printPrescription:
    "Could not print prescription. Check your connection and click Try Again.",
  search:
    "Could not search by name. Check your connection and click Try Again.",
  prescription:
    "Could not submit prescription. Check your connection and click Try Again.",
} as const;

export async function withRetries<T>(
  attempt: () => Promise<T>,
  options: RetryDelays & {
    shouldRetry: (result: T) => boolean;
    mapExhausted?: (last: T) => T;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const extra = options.extraAttempts ?? 2;
  const delays = options.delaysMs ?? [250, 750];
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let last!: T;
  for (let i = 0; i <= extra; i += 1) {
    if (i > 0) {
      const delay = delays[i - 1] ?? delays[delays.length - 1] ?? 500;
      await sleep(delay);
    }
    last = await attempt();
    if (!options.shouldRetry(last)) return last;
  }

  return options.mapExhausted ? options.mapExhausted(last) : last;
}
