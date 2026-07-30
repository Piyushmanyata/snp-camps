/**
 * #58 — Decoder orchestration: single in-flight detect, generation guards,
 * pause (review), freeze (terminal recovery), duplicate debounce.
 * Framework-free; React owns animation frames and media elements.
 */

export type DecodeSource = HTMLVideoElement | HTMLCanvasElement | ImageBitmap;

export type NativeDetect = (source: DecodeSource) => Promise<{ rawValue: string }[]>;

export type DecodeOrchestratorOptions = {
  /** Return false when session token is no longer current or unmounted. */
  isLive: () => boolean;
  onDecoded: (rawValue: string) => void;
  /** Ignore this exact raw value after resume (just-seen QR). */
  debounceMs?: number;
};

export class QrDecodeOrchestrator {
  private paused = false;
  private frozen = false;
  private inFlight = false;
  private debounceRaw: string | null = null;
  private debounceUntil = 0;
  private readonly debounceMs: number;
  private readonly isLive: () => boolean;
  private readonly onDecoded: (rawValue: string) => void;

  constructor(options: DecodeOrchestratorOptions) {
    this.isLive = options.isLive;
    this.onDecoded = options.onDecoded;
    this.debounceMs = options.debounceMs ?? 2500;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  /** Pause decoding while review is open; stream may stay live. */
  pause(): void {
    this.paused = true;
  }

  /** Resume after successful Mark seen / cancel review (same session). */
  resume(): void {
    this.paused = false;
    this.frozen = false;
  }

  /** Terminal lookup/decode exhaustion — no auto re-arm until unfreeze. */
  freeze(): void {
    this.frozen = true;
    this.paused = true;
  }

  unfreeze(): void {
    this.frozen = false;
    this.paused = false;
  }

  /** After marking a patient seen from camera, ignore the same QR briefly. */
  debounceRawValue(raw: string): void {
    this.debounceRaw = raw;
    this.debounceUntil = Date.now() + this.debounceMs;
  }

  clearDebounce(): void {
    this.debounceRaw = null;
    this.debounceUntil = 0;
  }

  shouldRunFrame(): boolean {
    return this.isLive() && !this.paused && !this.frozen && !this.inFlight;
  }

  /**
   * Run one native detect. Generation is re-checked after the await.
   * Returns true if a live callback fired and decode should stop looping
   * until pause/resume (handled by caller via pause).
   */
  async runNativeDetect(
    source: DecodeSource,
    detect: NativeDetect,
  ): Promise<boolean> {
    if (!this.shouldRunFrame()) return false;
    this.inFlight = true;
    try {
      const barcodes = await detect(source);
      if (!this.isLive() || this.paused || this.frozen) return false;
      if (!barcodes?.length) return false;
      for (const barcode of barcodes) {
        const raw = barcode?.rawValue;
        if (!raw) continue;
        if (this.isDebounced(raw)) continue;
        if (!this.isLive() || this.paused || this.frozen) return false;
        this.onDecoded(raw);
        return true;
      }
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Sync jsQR path — still respects pause/freeze/live and debounce.
   */
  runSyncDecode(raw: string | null): boolean {
    if (!raw) return false;
    if (!this.isLive() || this.paused || this.frozen) return false;
    if (this.isDebounced(raw)) return false;
    this.onDecoded(raw);
    return true;
  }

  private isDebounced(raw: string): boolean {
    if (!this.debounceRaw) return false;
    if (Date.now() > this.debounceUntil) {
      this.clearDebounce();
      return false;
    }
    return raw === this.debounceRaw;
  }
}
