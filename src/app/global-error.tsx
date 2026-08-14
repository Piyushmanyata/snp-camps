"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Root layout failed", {
      digest: error.digest,
      message: error.message,
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          background: "#f8fafc",
          color: "#0f172a",
        }}
      >
        <main
          id="main"
          style={{
            maxWidth: "28rem",
            margin: "0 auto",
            padding: "3rem 1rem",
          }}
        >
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700 }}>
            Something went wrong
          </h1>
          <p style={{ marginTop: "0.75rem", fontSize: "0.9375rem", color: "#475569" }}>
            The page could not load. Check your connection and try again.
            {error.digest ? (
              <>
                {" "}
                Reference:{" "}
                <span style={{ fontFamily: "ui-monospace, monospace" }}>
                  {error.digest}
                </span>
              </>
            ) : null}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1.25rem",
              minHeight: "3rem",
              padding: "0 1.25rem",
              borderRadius: "0.75rem",
              border: "none",
              background: "#0f766e",
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
