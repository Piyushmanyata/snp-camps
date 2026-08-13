export default function Loading() {
  return (
    <div
      className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6"
      role="status"
      aria-label="Loading"
    >
      <div className="animate-pulse space-y-3">
        <div className="h-3 w-24 rounded bg-border/70" />
        <div className="h-9 w-56 rounded-lg bg-border/60" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="h-44 rounded-2xl border border-border/60 bg-card" />
          <div className="h-44 rounded-2xl border border-border/60 bg-card" />
        </div>
        <div className="h-32 rounded-2xl border border-border/60 bg-card" />
      </div>
      <p className="sr-only">Loading page…</p>
    </div>
  );
}
