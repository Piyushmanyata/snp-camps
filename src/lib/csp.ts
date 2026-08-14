export function buildContentSecurityPolicy(
  nonce: string,
  options?: {
    isDev?: boolean;
    supabaseHttpOrigin?: string;
    supabaseSocketOrigin?: string;
  },
): string {
  const isDev =
    options?.isDev ?? process.env.NODE_ENV === "development";
  const supabaseHttp =
    options?.supabaseHttpOrigin ??
    (process.env.NEXT_PUBLIC_SUPABASE_URL
      ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
      : "https://*.supabase.co");
  const supabaseSocket =
    options?.supabaseSocketOrigin ??
    (process.env.NEXT_PUBLIC_SUPABASE_URL
      ? (() => {
          const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
          return `${u.protocol === "http:" ? "ws:" : "wss:"}//${u.host}`;
        })()
      : "wss://*.supabase.co");

  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`;

  return [
    "default-src 'self'",
    `connect-src 'self' ${supabaseHttp} ${supabaseSocket}`,
    scriptSrc,
    // Tailwind / UI still rely on inline styles; not in #13 scope.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export function productionScriptSrcAllowsUnsafeInline(csp: string): boolean {
  const script = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"));
  if (!script) return false;
  return /'unsafe-inline'/.test(script);
}
