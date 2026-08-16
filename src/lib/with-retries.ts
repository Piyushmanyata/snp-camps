
export type RetryDelays = {
  extraAttempts?: number;
  delaysMs?: number[];
};

/** Volunteer-facing copy after automatic retries are exhausted (#47 / #32 / #61). */
export const RETRY_EXHAUSTED_COPY = {
  register: "Save nahi ho paya. Internet check karke Try Again dabayein.",
  lookup:
    "Patient lookup nahi ho paya. Internet check karke Try Again dabayein.",
  markSeen:
    "Dekha hua nahi ho paya. Internet check karke Try Again dabayein.",
  undo:
    "Undo nahi ho paya. Internet check karke Try Again dabayein.",
  changeDay:
    "Din change nahi ho paya. Internet check karke Try Again dabayein.",
  printPrescription:
    "Parchi print nahi ho payi. Internet check karke Try Again dabayein.",
  search:
    "Naam search nahi ho paya. Internet check karke Try Again dabayein.",
  prescription:
    "Prescription submit nahi ho paya. Internet check karke Try Again dabayein.",
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
