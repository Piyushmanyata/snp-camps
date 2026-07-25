/** Plain not-found — no hint that a token was close or revoked. */
export default function StatusNotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center text-foreground">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted">This status link is not available.</p>
    </main>
  );
}
