
export type GetUserMedia = (
  constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

export class QrCameraSession {
  private generation = 0;
  private stream: MediaStream | null = null;

  get token(): number {
    return this.generation;
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }

  begin(): number {
    this.stopTracks();
    this.generation += 1;
    return this.generation;
  }

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
    }
    this.stream = null;
  }

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
      }
      return null;
    }
    this.stopTracks();
    this.stream = stream;
    return stream;
  }

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
        const name =
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          typeof error.name === "string"
            ? error.name
            : "";
        if (name === "NotAllowedError" || name === "SecurityError") return null;
        continue;
      }
      if (!this.isCurrent(token)) {
        try {
          stream.getTracks().forEach((track) => track.stop());
        } catch {
        }
        return null;
      }
      this.stopTracks();
      this.stream = stream;
      return stream;
    }
    return null;
  }

  releaseTracksKeepGeneration(): void {
    this.stopTracks();
  }
}
