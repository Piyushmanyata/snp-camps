/**
 * Minimal NextResponse for route-handler unit tests under plain Node.
 * Mirrors the subset of next/server that our handlers use.
 */
export class NextResponse extends Response {
  static json(body, init = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return new NextResponse(JSON.stringify(body), { ...init, headers });
  }
}
