/**
 * Shared quiet-retry helper for desk mutations and lookups (#47, #32).
 * Exactly one of these in the codebase — do not add a second retry framework.
 */

export type RetryDelays = {
  /** Attempts after the first call. Default two → three tries total. */
  extraAttempts?: number;
  /** Delay before each retry (ms). Length should match extraAttempts. */
  delaysMs?: number[];
};

/** Volunteer-facing copy after automatic retries are exhausted (#47 / #32 / #61). */
export const RETRY_EXHAUSTED_COPY = {
  register: "Could not save. Check the internet and press Try Again.",
  lookup:
    "Could not look up this patient. Check the internet and press Try Again.",
  /** @deprecated Use markSeen / undo — kept for older call sites. */
  assign:
    "Could not mark this patient seen. Check the internet and press Try Again.",
  markSeen:
    "Could not mark this patient seen. Check the internet and press Try Again.",
  undo:
    "Could not undo mark-seen. Check the internet and press Try Again.",
  changeDay:
    "Could not change the day. Check the internet and press Try Again.",
  checkIn:
    "Could not check in this patient. Check the internet and press Try Again.",
  search:
    "Could not search names. Check the internet and press Try Again.",
  prescription:
    "Could not submit prescription. Check the internet and press Try Again.",
} as const;

/**
 * Call `attempt` up to 1 + extraAttempts times with short backoff.
 * Stops early when `shouldRetry` is false (success or non-retryable).
 */
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
