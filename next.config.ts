import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Next 16 Cache Components — required for "use cache" / cacheTag / cacheLife
  // (replaces unstable_cache; see node_modules/next/dist/docs/.../use-cache.md).
  cacheComponents: true,
  turbopack: {
    root: path.join(__dirname),
    resolveAlias: {
      // OpenCV's Emscripten bundle keeps its Node and browser bootstraps in one
      // file; the Node branch requires "fs" and never runs in a browser, but
      // the bundler still has to resolve it. See src/lib/node-builtin-stub.ts.
      fs: { browser: "./src/lib/node-builtin-stub.ts" },
      path: { browser: "./src/lib/node-builtin-stub.ts" },
      crypto: { browser: "./src/lib/node-builtin-stub.ts" },
    },
  },
  poweredByHeader: false,
  compress: true,
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: [
      "qrcode.react",
      "@supabase/supabase-js",
      "@supabase/ssr",
    ],
  },
  async headers() {
    // CSP (with per-request nonce) is set in src/proxy.ts — not here.
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "X-DNS-Prefetch-Control",
            value: "on",
          },
        ],
      },
      {
        source: "/favicon.ico",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        source: "/api/(.*)",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
    ];
  },
};

export default nextConfig;
