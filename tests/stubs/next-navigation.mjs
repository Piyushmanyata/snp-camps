/**
 * Minimal next/navigation stub for Server Component & Route Handler tests.
 */
export class RedirectError extends Error {
  constructor(url) {
    super(`NEXT_REDIRECT: ${url}`);
    this.name = "RedirectError";
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
    this.url = url;
  }
}

export function redirect(url) {
  throw new RedirectError(url);
}

export function notFound() {
  const err = new Error("NEXT_NOT_FOUND");
  err.digest = "NEXT_NOT_FOUND";
  throw err;
}
