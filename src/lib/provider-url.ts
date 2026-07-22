/** Sensitive identity data may leave the app only over HTTPS in production. */
export function sensitiveProviderUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return url.toString();

    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (process.env.NODE_ENV !== "production" && local && url.protocol === "http:") {
      return url.toString();
    }
  } catch {
    return null;
  }

  return null;
}
