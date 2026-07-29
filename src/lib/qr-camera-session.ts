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
   * Try camera profiles from most useful to most compatible.
   *
   * `ideal` constraints should be best-effort, but several Android OEM camera
   * stacks still reject a high-resolution request outright. Retrying without
   * width/height keeps those phones on the rear camera instead of sending the
   * operator straight to manual entry.
   */
  async acquireFirstAvailable(
    token: number,
    getUserMedia: GetUserMedia,
    profiles: MediaStreamConstraints[],
  ): Promise<MediaStream | null> {
    for (const constraints of profiles) {
      if (!this.isCurrent(token)) return null;
      let stream: MediaStream;
      try {
        stream = await getUserMedia(constraints);
      } catch (error) {
        // WebViews may surface a named error from a different JS realm, where
        // `instanceof DOMException` is false. The name is the stable contract.
        const name =
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          typeof error.name === "string"
            ? error.name
            : "";
        // Permission/security failures are terminal. Retrying would only repeat
        // the prompt or denial; profile fallback is for camera-stack failures.
        if (name === "NotAllowedError" || name === "SecurityError") return null;
        continue;
      }
      if (!this.isCurrent(token)) {
        try {
          stream.getTracks().forEach((track) => track.stop());
        } catch {
          /* ignore */
        }
        return null;
      }
      this.stopTracks();
      this.stream = stream;
      return stream;
    }
    return null;
  }

  /**
   * Release tracks without bumping generation (pause-with-hold uses decode
   * pause instead). Prefer invalidate() for Stop / unmount.
   */
  releaseTracksKeepGeneration(): void {
    this.stopTracks();
  }
}
