/**
 * #58 — Camera session lifecycle (generation token + track ownership).
 * No React. Invalidate is synchronous; every await must re-check isCurrent.
 */

export type GetUserMedia = (
  constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

export class QrCameraSession {
  private generation = 0;
  private stream: MediaStream | null = null;

  /** Current session token (increments on invalidate / begin). */
  get token(): number {
    return this.generation;
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }

  /** Begin a new session; invalidates any prior generation and stops tracks. */
  begin(): number {
    this.stopTracks();
    this.generation += 1;
    return this.generation;
  }

  /**
   * Hard cancel: bump generation and stop tracks.
   * Callers must not write React state after unmount using this alone.
   */
  invalidate(): number {
    this.generation += 1;
    this.stopTracks();
    return this.generation;
  }

  stopTracks(): void {
    if (!this.stream) return;
    try {
      this.stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    this.stream = null;
  }

  /**
   * Acquire a stream for `token`. If the token is stale after getUserMedia,
   * acquired tracks are stopped and null is returned.
   */
  async acquire(
    token: number,
    getUserMedia: GetUserMedia,
    constraints: MediaStreamConstraints,
  ): Promise<MediaStream | null> {
    if (!this.isCurrent(token)) return null;
    let stream: MediaStream;
    try {
      stream = await getUserMedia(constraints);
    } catch {
      return null;
    }
    if (!this.isCurrent(token)) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      return null;
    }
    // Replace any prior stream for this session.
    this.stopTracks();
    this.stream = stream;
    return stream;
  }

  /**
   * Release tracks without bumping generation (pause-with-hold uses decode
   * pause instead). Prefer invalidate() for Stop / unmount.
   */
  releaseTracksKeepGeneration(): void {
    this.stopTracks();
  }
}
