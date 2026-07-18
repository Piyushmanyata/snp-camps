export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-4xl animate-pulse px-4 py-6 sm:px-6">
      <div className="h-3 w-24 rounded bg-border" />
      <div className="mt-3 h-9 w-56 rounded-lg bg-border/80" />
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="h-44 rounded-2xl border border-border bg-card" />
        <div className="h-44 rounded-2xl border border-border bg-card" />
      </div>
      <p className="sr-only" role="status">
        Loading page
      </p>
    </div>
  );
}
