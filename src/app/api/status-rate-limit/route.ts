import { NextResponse } from "next/server";

export function GET(request: Request) {
  const url = new URL(request.url);
  const retry = Number(url.searchParams.get("retry"));
  const retryAfter = Number.isInteger(retry) && retry > 0 ? Math.min(retry, 300) : 1;
  const unavailable = url.searchParams.get("status") === "503";
  const status = unavailable ? 503 : 429;
  const message = unavailable
    ? "Status seva abhi uplabdh nahi hai. Thodi der baad dobara koshish karein."
    : "Bahut zyada requests aa rahi hain. Thodi der baad dobara koshish karein.";

  return new NextResponse(
    `<!doctype html><html lang="hi-Latn"><body><main id="main"><h1>${message}</h1></main></body></html>`,
    {
      status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Type": "text/html; charset=utf-8",
        "Retry-After": String(retryAfter),
      },
    },
  );
}
